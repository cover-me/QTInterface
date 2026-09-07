import gc
import yaml
import os
import importlib
import numpy as np
import threading
from typing import List, Any, Optional
from qcodes.station import Station
from qcodes.instrument import Instrument
from qcodes.parameters import Parameter, DelegateParameter, ManualParameter
import math
import qcodes.validators as validators
import traceback
from qcodes.validators import Strings, Numbers
import pkgutil
from contextlib import contextmanager, nullcontext 
import time
import pythoncom

from core.qc_measure_20260902 import QMeasure
from pathlib import Path
from qcodes.dataset.sqlite.database import initialise_or_create_database_at


class StationManager():
    def __init__(self, station=None, use_lock=True):
        self.station = station if station else Station()
        self.use_lock = use_lock
        self.use_cache = False
        self.disable_setting = False
        self.disable_getting = False
        self.driver_folders = ("drivers",)#  ("drivers", "qcodes.instrument_drivers")
        if self.use_lock:
            self.quasi_lock = threading.Lock()
        else:
            self.quasi_lock = nullcontext()
        self._available_drivers = self.list_instrument_classes()
        self._msg_for_terminal = ''
        self._last_msg = ''
        self._para_time = Parameter("timestamp", unit="s", get_cmd=time.time)

    ########## safety ##########
        
    def set_para(self, p, val):
        if self.disable_setting:
            return
        with self.quasi_lock:
            p.set(val)

    def get_para(self, p):
        if self.disable_getting:
            return
        with self.quasi_lock:
            if self.use_cache:
                return p.cache.get()
            else:
                return p.get()
                
    def _set_para_guimeta(self, p, key, val):
        if self.disable_setting:
            return
        with self.quasi_lock:
            if 'gui' in p.metadata:
                p.metadata['gui'][key] = val
            else:
                p.metadata['gui'] = {key: val}
            
    def _get_para_guimeta(self, p, key=None):
        if self.disable_getting:
            return
        with self.quasi_lock:
            if 'gui' in p.metadata:
                d_gui = p.metadata['gui']
            else:
                d_gui = {}
            if key:
                return d_gui.get(key)
            else:
                return d_gui
                
    ########## UI ##########
    def list_instrument_classes(self) -> List[str]:
        result = []
        for pkg_name in self.driver_folders:
            try:
                pkg = importlib.import_module(pkg_name)
            except ModuleNotFoundError:
                continue
            for _, modname, ispkg in pkgutil.walk_packages(pkg.__path__, pkg.__name__ + "."):
                if ispkg:
                    continue
                try:
                    mod = importlib.import_module(modname)
                except Exception:
                    continue
                for name in dir(mod):
                    cls = getattr(mod, name)
                    if (isinstance(cls, type) and issubclass(cls, Instrument)
                            and cls is not Instrument and cls.__module__ == mod.__name__):
                        result.append(f"{cls.__module__}.{cls.__qualname__}")
        return result
        
    def add_msg_for_terminal(self, msg, clear=False):
        if not msg:
            return
        if clear:
            print('\r',end='')
            self._msg_for_terminal = ''
        print(msg,end='')
        self._msg_for_terminal += msg        
        
    def get_msg(self):
        data = {'msg': self._msg_for_terminal.strip()}
        return data
        
    def get_available_instrument_drivers(self):
        return self._available_drivers

    ########## station ##########
    
    def get_station_component(self, name):
        station = self.station
        if station is not None and name in station.components:
            comp = station.components[name]
            return comp

    def get_driver(self, driver_str):
        try:
            module_name, class_name = driver_str.rsplit(".", 1)
            module = importlib.import_module(module_name)
            driver = getattr(module, class_name)
            return driver
        except:
            return None

    def close_station(self):
        station = self.station
        if station:
            for comp_name in list(station.components):
                comp = station.components[comp_name]
                if isinstance(comp, Instrument):
                    station.close_and_remove_instrument(comp)
                    Instrument.remove_instance(comp)
                else:
                    self.remove_parameter(comp_name)

    def load_station_from_yaml(self, config_path: str):
        if self.station is not None:
            self.close_station()
        
        # Load file
        if not os.path.exists(config_path):
            return
        with open(config_path, "r", encoding="utf-8") as f:
            config_data = yaml.safe_load(f)

        instruments_cfg = config_data.get("instruments", {})
        parameters_cfg = config_data.get("parameters", {})
        # Add instruments
        self.add_msg_for_terminal("===== Add instruments =====\n")
        for inst_key, inst_comp in instruments_cfg.items():
            driver_str = inst_comp.get("driver")
            address = inst_comp.get("address", "")
            self.add_instrument(inst_key, driver_str, address)
        # Add parameters
        self.add_msg_for_terminal("===== Add parameters =====\n")
        for para_key, para_comp in parameters_cfg.items():
            source_str = para_comp.get("source")
            acquire_in_scan = para_comp.get("acquire_in_scan")
            self.add_parameter(para_key, source_str, acquire_in_scan)
            
    ########## instrument ##########
    
    def add_instrument(self, name, driver_str, address):
        station = self.station
        if station is None or name in station.components:
            return
        try:
            self.add_msg_for_terminal(f"[add_instrument] {name} {driver_str}\n")
            driver = self.get_driver(driver_str)
            inst = driver(name=name, address=address)
            station.add_component(inst)
            if hasattr(inst, "clear"):
                inst.clear()
        except Exception as e:
            self.add_msg_for_terminal(f"[add_instrument] error {name} ({e})\n")

    def get_instrument_names(self):
        station = self.station
        inst_names = [comp_name for comp_name in station.components if isinstance(station.components[comp_name], Instrument)]
        return inst_names
    
    def get_all_instruments(self):
        insts_data = {}
        for i in self.get_instrument_names():
            insts_data[i] = self.get_instrument(i)
        return insts_data
            
    def get_instrument(self, name):
        try:
            inst = self.get_station_component(name)
            class_str = f'{inst.__class__.__name__}'
            idn_str = ''
            address = inst.address if hasattr(inst,'address') else ''
            
            paras_data = {}
            for p_name, p in inst.parameters.items():
                val = self.get_para_data_by_name_or_obj(p)
                if p_name == 'IDN' and val is not None:
                    idn_str = ', '.join(list(val['value'].values()))
                    val['value'] = f'{address}, {class_str}, {idn_str}'
                paras_data[p_name] = val
            inst_data = {
                "name": inst.name,
                "parameters": paras_data
            }
            return inst_data
        except Exception as e:
            self.add_msg_for_terminal(f"[get_instrument] error {name} ({e})\n")

    def is_para_from_inst(self, para, inst):
        if getattr(para, "root_instrument") is inst:
            return True
        if hasattr(para, "source") and self.is_para_from_inst(para.source, inst):
            return True
        if hasattr(para, "_component_dict") and any(self.is_para_from_inst(i,inst) for i in para._component_dict.values()):
            return True
        return False

    def is_instrument_in_use(self, inst):
        station = self.station
        if not station:
            return False
        for comp in station.components.values():
            if isinstance(comp, Instrument):
                if comp is inst:
                    continue
                for para in comp.parameters.values():
                    if self.is_para_from_inst(para, inst):
                        return True
            elif isinstance(comp, Parameter):
                    if self.is_para_from_inst(comp, inst):
                        return True
        return False

    def remove_instrument(self, name):   
        station = self.station
        if not station:
            return
        inst = self.get_station_component(name)
        if not isinstance(inst, Instrument):
            return
        if self.is_instrument_in_use(inst):
            return
        station.close_and_remove_instrument(name)
        
    ########## parameter ##########

    def js_value_to_value(self, value, vals):
        if isinstance(vals, validators.Arrays):
            value = np.asarray(value)
        if vals:
            vals.validate(value)
        return value

    def get_para_instance(self, inst_para_str):
        if not '.' in inst_para_str:
            return None
        inst_name, para_name = inst_para_str.split(".", maxsplit=1)
        inst = self.get_station_component(inst_name)
        return getattr(inst, para_name)

    def set_companied_ramprate(self, para, rate_val):
        ramp_rate_name = self._get_para_guimeta(para,'ramp_rate_parameter')
        if ramp_rate_name:
            ramp_rate_para = para.root_instrument.parameters.get(ramp_rate_name)
            if ramp_rate_para:
                self.set_para(ramp_rate_para, rate_val)
    
    def get_companied_ramprate(self, para):
        rate_val = None
        rate_unit = ""
        ramp_rate_name = self._get_para_guimeta(para,'ramp_rate_parameter')
        if ramp_rate_name:
            ramp_rate_para = para.root_instrument.parameters.get(ramp_rate_name)
            if ramp_rate_para:
                rate_val = self.get_para(ramp_rate_para)
                rate_unit = ramp_rate_para.unit
        return rate_val, rate_unit

    def set_para_properties(self, para, ppdata):
        a = ppdata.get('min_value')
        b = ppdata.get('max_value')
        a = -float('inf') if a is None else a
        b = float('inf') if b is None else b
        with self.quasi_lock:
            if isinstance(para.vals, Numbers):
                para.vals._min_value  = a
                para.vals._max_value = b
            for i in ["step", "inter_delay"]:
                val = ppdata.get(i)
                setattr(para, i, val)

        acquire_in_scan =  ppdata.get('acquire_in_scan')
        if acquire_in_scan is not None:
            self._set_para_guimeta(para, 'acquire_in_scan',)

        val = ppdata.get('ramp_rate')
        if isinstance(val, (int, float)):
            self.set_companied_ramprate(para, val)

    def update_gui_meta(self, para, acquire_in_scan=None, name=None):
        rate_val, rate_unit = self.get_companied_ramprate(para)
        self._set_para_guimeta(para, "ramp_rate", rate_val)
        self._set_para_guimeta(para, "ramp_rate_unit", rate_unit)
        
        if acquire_in_scan is not None:
            self._set_para_guimeta(para, "acquire_in_scan", acquire_in_scan)
        
        if name is not None:
            self._set_para_guimeta(para, "name", name)

    def set_instrument_parameter(self, payload):
        try:
            name = payload.get("parameter")
            value = payload.get("value")
            para = self.get_para_instance(name)
            value = self.js_value_to_value(value, para.vals)

            self.set_para(para, value)
            if payload.get('set_meta'):
                self.set_para_properties(para, payload)

        except Exception as e:
            self.add_msg_for_terminal(f"[set_instrument_parameter] error {name} {value} {e}\n")

    def get_para_insts_in_station(self):
        station = self.station
        if station is None:
            return
        return [comp for comp_name, comp in station.components.items() if isinstance(comp, Parameter)]

    def get_para_strs_in_station(self):
        p_list = self.get_para_insts_in_station()
        return [f'{p.root_instrument.name}.{p.name}' for p in p_list]

    def get_para_names_in_station(self):
        station = self.station
        if station is None:
            return
        return [comp_name for comp_name, comp in station.components.items() if isinstance(comp, Parameter)]

    def add_parameter(self, name, source_str, acquire_in_scan):
        station = self.station
        if station is None or source_str in self.get_para_strs_in_station() or "." not in source_str:
            return
        if name in station.components:
            return
        inst_name, source_para_name = source_str.split(".", maxsplit=1)
        inst = self.get_station_component(inst_name)
        if not inst:
            return
        source_para = getattr(inst, source_para_name, None)
        if not isinstance(source_para, Parameter):
            return
        
        self.update_gui_meta(source_para, acquire_in_scan, name)

        self.add_msg_for_terminal(f"[add_parameter] {source_str} -> {name}\n")
        station.add_component(source_para,name)

    def remove_parameter(self, name):
        self.add_msg_for_terminal(f"Removing Parameter: {name}\n")
        station = self.station
        if station:
            station.remove_component(name)

    def get_instrument_parameter(self, inst_name, para_name, updt_gui_meta):
        inst = self.get_station_component(inst_name)
        p = getattr(inst, para_name)
        return self.get_para_data_by_name_or_obj(p, updt_gui_meta=updt_gui_meta)
        
    def get_para_data_by_name_or_obj(self, name_or_obj, updt_gui_meta=False):
        if name_or_obj is None:
            paras_data = {}
            for i in self.get_para_names_in_station():
                paras_data[i] = self.get_para_data_by_name_or_obj(i, updt_gui_meta)
            return paras_data
        try:
            if isinstance(name_or_obj, str):
                p = self.get_station_component(name_or_obj)
            else:
                p = name_or_obj
            
            
            with self.quasi_lock:
                vals = p.vals
                min_val = vals.min_value if hasattr(vals, "min_value") else None
                if min_val is not None and math.isinf(min_val):
                    min_val = None
                max_val = vals.max_value if hasattr(vals, "max_value") else None
                if max_val is not None and math.isinf(max_val):
                    max_val = None

            if updt_gui_meta:
                self.update_gui_meta(p)

            value = self.get_para(p)
            
            if isinstance(value, np.ndarray):
                value = value.tolist()

            para_data = {
                "src_name": f'{p.root_instrument.name}.{p.name}',
                "scaled": p.scale if isinstance(p, DelegateParameter) else None,
                "value": value,
                "unit": p.unit,
                "settable": p.settable,
                "min_value": min_val,
                "max_value": max_val,
                "inter_delay": p.inter_delay,
                "step": p.step,
                "metadata": self._get_para_guimeta(p),
            }
            return para_data
        except Exception as e:
            self.add_msg_for_terminal(f"[get_para_data_by_name_or_obj error] {p.name} {e}\n")


# def get_station_snapshot():
    # station = self.station
    # st = station.snapshot()
    # return st
    
    
    def get_acq_paras(self):
        station = self.station
        if station is None:
            return None
        acq_paras = [DelegateParameter(name=comp_name, source=comp) for comp_name, comp in station.components.items() 
            if isinstance(comp, Parameter) and self._get_para_guimeta(comp, 'acquire_in_scan')
            ]
        return acq_paras + [self._para_time]
        
# def get_instrument_list(self):
    # station = self.station
    # if station is None:
        # return None
    # return [comp for comp_name, comp in station.components.items() if isinstance(comp, Instrument)]
    
class ScanManager():
    def __init__(self, station_manager):
        self.station_manager = station_manager
        self.qm = None
        self.current_task = None
        self.scan_list = []
        self.scan_conf = {}

    def calculate_working_path(self):
        path = ""
        data_dir = self.scan_conf["storage"]['data_dir']
        user = self.scan_conf["storage"]['user']
        exp_name = self.scan_conf["storage"]['exp_name']
        fridge = self.scan_conf["storage"]['fridge']
        if data_dir and user and exp_name and fridge:
            path = str(Path(data_dir) / user / f"{exp_name}_{fridge}")
        return path

    def calculate_db_path(self):
        work_path = self.scan_conf["storage"]['calced_work_path']
        user = self.scan_conf["storage"]['user']
        exp_name = self.scan_conf["storage"]['exp_name']
        fridge = self.scan_conf["storage"]['fridge']
        if work_path and user and exp_name and fridge:
            path = str(Path(work_path) / f"{user}.{exp_name}.{fridge}.db")
        return path
        
    def set_storage_conf(self, conf):
        self.scan_conf["storage"] = conf
        self.scan_conf["storage"]["calced_work_path"] = self.calculate_working_path()

    def set_chips_conf(self, conf):
        self.scan_conf["chips"] = conf

    def load_conf(self, config_path):
        if not os.path.exists(config_path):
            return
        with open(config_path, "r", encoding="utf-8") as f:
            config_data = yaml.safe_load(f)
        self.set_storage_conf(config_data.get("storage"))
        self.set_chips_conf(config_data.get("chips"))

    def add_to_queue(self, task_para_dict):
        print(task_para_dict)
        for i in ['scanBwd', 'scanCts']:
            if not type(task_para_dict.get('scanBwd'))==bool:
                self.station_manager.add_msg_for_terminal(f'[add_to_queue] error scanBwd or scanCts not bool\n')        
                return
        for i in ['x', 'y']:
            pname = task_para_dict.get(f'{i}Param')
            pvals = task_para_dict.get(f'{i}Values')
            if pname:
                if type(pname) != str:
                    self.station_manager.add_msg_for_terminal(f'[add_to_queue] error xParam or yParam not string\n')
                    return
                if any([j is None for j in pvals]):
                    self.station_manager.add_msg_for_terminal(f'[add_to_queue] error xValues or yValues 0\n')
                    return
            elif pvals[2] is None or pvals[3] is None:
                self.station_manager.add_msg_for_terminal(f'[add_to_queue] error xValues or yValues 1\n')
                return
            else:
                pvals[0] = 0
                pvals[1] = pvals[2] - 1
            if any([not isinstance(j, (int,float)) for j in pvals]):
                self.station_manager.add_msg_for_terminal(f'[add_to_queue] error xValues or yValues 2\n')
                return

        self.station_manager.add_msg_for_terminal(f'{task_para_dict}\n')        
        self.scan_list.append(task_para_dict)

    def get_global_status(self):
        return self._get_scan_status()

    def get_queue(self):
        return {"status": self.get_global_status(), "queue": self.scan_list}

    def stop(self):
        self._set_scan_status("Stopping")
        while self._get_scan_status() != "Stopped":
            time.sleep(0.1)

    def pause(self):
        d = {
            "Running": ('Pausing', 'Paused'),
            "Paused": ('Resuming', 'Running'),
            }
        status = self._get_scan_status()
        status_seq = d[status]
        self._set_scan_status(status_seq[0])
        while self._get_scan_status() != status_seq[1]:
            time.sleep(0.1)

    def remove_scan_from_queue(self,ind):
        return self.scan_list.pop(ind)

    def start_queue(self):
        try:
            self.station_manager.use_cache = True
            self.qm = None
            self._thread = threading.Thread(target=self._run_queue_loop, daemon=True)
            self._thread.start()
            while self.get_global_status() != "Running":
                time.sleep(0.1)
        except Exception as e:
            self.station_manager.add_msg_for_terminal(f"[start_queue] error: {e}\n")       
        finally:
            self.station_manager.use_cache = False
        
    def _get_xy_paras(self,task):
        station = Station.default
        if not station:
            return None, None
        x_para = task.get("xParam")
        y_para = task.get("yParam")
        xp = station.components.get(x_para)
        yp = station.components.get(y_para)
        return xp, yp

    def _run_queue_loop(self):
        pythoncom.CoInitialize()
        try:
            while self.scan_list:
                task = self.scan_list[0]
                task["status"] = "Running"
                self.current_task = task
                self._run_single_scan(task)
                self.scan_list.pop(0)
            self.current_task = None
        except Exception as e:
            if str(e) == "Stopped":
                self._set_scan_status("Stopped")
            else:
                self.station_manager.add_msg_for_terminal(f"[_run_queue_loop] error: {e}\n")
                self._set_scan_status("Error")
        finally:
            pythoncom.CoUninitialize()

    def _get_scan_status(self):
        if self.qm:
            val = self.qm._get_scan_status()
            if self.current_task:
                self.current_task["status"] = val
            # print('valllllllllllllll', val)
        elif self.current_task:
            val = self.current_task["status"]
            # print('55555555555valllllllllllllll', val)
        else:
            val = 'Idle'
        return val
    
    def _set_scan_status(self,val):
        if self.qm:
            self.qm._set_scan_status(val)
        if self.current_task:
            self.current_task["status"] = val
       
    def _run_single_scan(self, task_para_dict):
        self._qc_measure_wrapper(task_para_dict)
        # self._dummy_single_scan(task_para_dict)
    
    def _init_db_file(self):
        db_path = Path(self.calculate_db_path())
        if not db_path.parent.exists():
            try:
                db_path.parent.mkdir(parents=True)
            except:
                raise Exception("Unable to create working folder")
        initialise_or_create_database_at(db_path)

    def _qc_measure_wrapper(self, task_para_dict):
        self.station_manager.add_msg_for_terminal(f'Preparing scan: {task_para_dict}\n', clear=True)
        
        self._init_db_file()

        exp_name = self.scan_conf["storage"]['exp_name']
        sample_name = '_and_'.join([i['name'] for i in self.scan_conf['chips']])
        db_path = self.calculate_db_path()
        qm = QMeasure(exp_name=exp_name,
            sample_name=sample_name,
            export_dat=True, 
            mute_qclient=False,
            station_manager=self.station_manager,
            )
        self.qm = qm
        para_list = self.station_manager.get_acq_paras()
        qm.set_parameters_to_aquire(para_list=para_list, parallel=True)
        qm.set_parameters_in_measurement_name([])

        xp, yp = self._get_xy_paras(task_para_dict)
        x_start, x_stop, x_points, x_delay = task_para_dict.get("xValues")
        y_start, y_stop, y_points, y_delay = task_para_dict.get("yValues")
        
        scanBwd = task_para_dict['scanBwd']
        scanCts = task_para_dict['scanCts']

        qm.set_scan_para('x', para=xp, start=x_start, stop=x_stop, points=x_points, delay=x_delay)
        qm.set_scan_para('y', para=yp, start=y_start, stop=y_stop, points=y_points, delay=y_delay)

        self.station_manager.add_msg_for_terminal(f'Starting...\n')

        qm.scan2d(bwd=scanBwd)
        
        self.get_global_status()
        self.station_manager.add_msg_for_terminal(f'Finished scan: {task_para_dict}\n')
    
    ####### dummy scan #######
    # def _dummy_single_scan(self, task_para_dict):
        # print(task_para_dict)
        # x_start, x_stop, x_points, x_delay = task_para_dict.get("xValues")
        # y_start, y_stop, y_points, y_delay = task_para_dict.get("yValues")
        # xp, yp = self._get_xy_paras(task_para_dict)       
        # for y in np.linspace(y_start, y_stop, y_points):
            # xp(x_start)
            # yp(y)
            # time.sleep(y_delay)
            # print(y)
            # for x in np.linspace(x_start, x_stop, x_points):
                # xp(x)
                # self._guard_scan(xp, yp)
                # time.sleep(x_delay)

    # def _guard_scan(self,xp,yp):
        # if self._get_scan_status() == "Running":
            # return
        # if self._get_scan_status() == "Stopping":
            # self._pausing_or_nothing(xp)
            # self._pausing_or_nothing(yp)
            # self._set_scan_status("Stopped")
            # raise Exception("Stopped")
        # if self._get_scan_status() == "Pausing":
            # self._pausing_or_nothing(xp)
            # self._pausing_or_nothing(yp)
            # self._set_scan_status("Paused")
            # while self._get_scan_status() == "Paused":
                # time.sleep(0.2)
            # return
        # if self._get_scan_status() == "Resuming":
            # self._pausing_or_nothing(xp, action_str="resume")
            # self._pausing_or_nothing(yp, action_str="resume")
            # self._set_scan_status("Running")
            # return
            
    # def _pausing_or_nothing(self, para, action_str="pause"):
        # d = {
            # "pause": ('Ramping', 'Pausing', 'Paused'),
            # "resume": ('Paused', 'Resuming', 'Ramping'),
            # }
        # status_seq = d[action_str]
        # if isinstance(para, Parameter) and para.metadata.get('ramp_status') == status_seq[0]:
            # para.metadata['ramp_status'] = status_seq[1]
            # while para.metadata['ramp_status'] != status_seq[2]:
                # time.sleep(0.2)
        

    
    
    
    