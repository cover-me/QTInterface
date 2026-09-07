import pandas as pd
import contextlib
import os
import sys
import time
import socket
import numpy as np
from tqdm import tqdm
import win32com.client as win32
from shutil import copyfile, rmtree
from tempfile import mkdtemp

import qcodes as qc
from qcodes.dataset.sqlite.database import initialise_or_create_database_at
from qcodes.dataset.experiment_container import load_or_create_experiment
from qcodes.dataset.measurements import Measurement
from qcodes.instrument.parameter import Parameter
from qcodes.dataset.threading import process_params_meas

def print_versions():
    import qcodes_contrib_drivers, plottr, matplotlib, scipy
    print('qcodes:', qc.__version__)
    print('qcodes_contrib_drivers:', qcodes_contrib_drivers.__version__)
    print('plottr:', plottr.__version__)
    print('python:',sys.version)
    print('matplotlib:', matplotlib.__version__)
    print('numpy:', np.__version__)
    print('scipy:', scipy.__version__)
    print('pandas:', pd.__version__)

def DummyParameter(name, unit):
    return Parameter(name=name, unit=unit, label='Dummy Parameter', set_cmd=None, get_cmd=None, initial_value=0)
    

class QMeasure:

    def __init__(self, exp_name, sample_name, export_dat=True, mute_qclient=False):
        self.exp_name = exp_name
        self.sample_name = sample_name
        self.export_dat = export_dat
        self.mute_qclient = mute_qclient
      
        # x fast axis, y slow axis, for 2d scan
        self.scan_para = {'x':{},'y':{}}
        self.scan_dim = 1
        self.monitor_para = {}
        self.meas_name_para = {}
        
        self.set_scan_parameter('x', para=None, start=None, stop=None, points=None, delay=0)
        self.set_scan_parameter('y', para=None, start=None, stop=None, points=None, delay=0)
        
        self.counter = 0
        
    def set_scan_parameter(self, axis='x', para=None, start=None, stop=None, points=None, delay=0):
        if para is None:
            setpoints = np.array([0])
            p = DummyParameter(name=f'dummy_{axis}', unit='')
        else:
            setpoints = np.linspace(start, stop, points)
            p = para
        if axis == 'y' and len(setpoints)>1:
            self.scan_dim = 2
            
        self.scan_para[axis]['setpoints'] = setpoints
        self.scan_para[axis]['parameter'] = p
        self.scan_para[axis]['delay'] = delay
        
    def set_parameters_to_aquire(self, para_list=[], parallel=True):
        self.monitor_para['list'] = para_list
        self.monitor_para['parallel'] = parallel
    
    def set_parameters_in_measurement_name(self, para_list=[]):
        self.meas_name_para = para_list

    def generate_measurement_name(self, bwd=False, scan_direction='up'):
        # scan info x axis
        para = self.scan_para['x']['parameter']
        label = f'{para.name} ({para.unit})' if para.unit else f'{para.name}'
        setpoints = self.scan_para['x']['setpoints']
        delay = self.scan_para['x']['delay']
        direction = '->' if scan_direction=='up' else '<-'
        bwd_str = ', bwd=True' if bwd else ''
        meas_name = f'X: {label}, {setpoints[0]} {direction} {setpoints[-1]}, pts: {len(setpoints)}, dly: {delay}{bwd_str}\n'        

        if self.scan_dim == 2:
            para = self.scan_para['y']['parameter']
            label = f'{para.name} ({para.unit})' if para.unit else f'{para.name}'
            setpoints = self.scan_para['y']['setpoints']
            delay = self.scan_para['y']['delay']
            direction = '->'
            meas_name += f'Y: {label}, {setpoints[0]} {direction} {setpoints[-1]}, pts: {len(setpoints)}, dly: {delay}\n'

        para_list = self.meas_name_para
        meas_name += 'Note: ['
        for para in para_list:
            label = f'{para.name} ({para.unit})' if para.unit else f'{para.name}'
            meas_name += f'{label}: {para()}, '
        meas_name = f'{meas_name[:-2]}], '
        para_list = self.monitor_para['list']
        meas_name += f"Aquire: [{', '.join([i.name for i in para_list])}]"

        return meas_name
        
    def _db_new_measure(self, bwd=False, scan_direction='up'):
        exp = load_or_create_experiment(experiment_name=self.exp_name,
                                      sample_name=self.sample_name)
        meas_name = self.generate_measurement_name(bwd, scan_direction)
        meas = Measurement(exp=exp, name=meas_name)

        scan_para_list = [self.scan_para['x']['parameter'],self.scan_para['y']['parameter']]

        for i in scan_para_list:
            meas.register_parameter(i)
        
        para_list = self.monitor_para['list']
        for i in para_list:
            meas.register_parameter(i, setpoints=scan_para_list)

        meas.write_period = 2
        return meas

    def db_new_measure(self,bwd=False):
        meas_list = [self._db_new_measure(bwd=bwd, scan_direction='up'),]
        if bwd:
            meas_list.append(self._db_new_measure(bwd=bwd, scan_direction='down'))
        return meas_list

    def _scan1d(self, datasaver, list_x, y):
        para_x = self.scan_para['x']['parameter']
        delay_x = self.scan_para['x']['delay']
        para_y = self.scan_para['y']['parameter']
        
        for x in self.tqdm_x(list_x):
            para_x(x)
            time.sleep(delay_x)
            vals = self._take_data()
            rslt = [(para_x, x), (para_y, y)] + vals
            datasaver.add_result(*rslt)

            if self.is_fwd_now or self.scan_dim==1:
                self.qclient.add_data([i[1] for i in rslt])
                self.qclient.update_plot()

    def _take_data(self):
        parameters_to_fetch = self.monitor_para['list']
        parallel = self.monitor_para['parallel']
        vals = process_params_meas(parameters_to_fetch, use_threads=parallel)
        return vals
    
    def tqdm_x(self, a):
        if self.scan_dim == 1:
            # Will show a processbar for x dimension
            return tqdm(a,leave=False)
        else:
            # No processbar for x dimension
            return a
            
    def tqdm_y(self, a):
        if self.scan_dim == 2:
            # Will show a processbar for y dimension
            return tqdm(a,leave=False)
        else:
            # No processbar for y dimension
            return a
            
    def _export_dat(self, dat_folder):
        d2d = Db2Dat()
        for i in self.id_list:
            last_dat_path = d2d.to_dat(qc.config.core.db_location, i, dat_folder,overwrite=True)
        return last_dat_path

    def to_time_str(self, t0,t1,t2,t3):
        x = t3 - t0
        minutes = x//60
        seconds = x%60
        
        x = (t2-t1)/len(self.scan_para['x']['setpoints'])
        
        return f'Total: {minutes:.0f} min {seconds:.0f} s. Each point: {x:.3f} s.'

    def scan2d(self, bwd=False):
        '''
        x is the inner loop
        y is the outter loop
        bwd = True means enabling backward scan (2 files will be created)
        '''
        dly_x = self.scan_para['x']['delay']
        para_x = self.scan_para['x']['parameter']
        list_x = self.scan_para['x']['setpoints']

        dly_y = self.scan_para['y']['delay']
        para_y = self.scan_para['y']['parameter']
        list_y = self.scan_para['y']['setpoints']

        # list of Measurement (a qcodes object)
        meas_list = self.db_new_measure(bwd)
        
        with contextlib.ExitStack() as stack:
            datasaver_list = [stack.enter_context(meas.run()) for meas in meas_list]
            self.id_list = [i.run_id for i in datasaver_list]

            self.qclient = qtplot_client(self.mute_qclient)
            self.qclient.init_temporary_file(datasaver_list[0].dataset,list_x,list_y)
            self.qclient.update_plot()

            # timestamp
            self.to_word(time.strftime(f'\n%m/%d %H:%M'),font_style=['blue','bold'])
            # id, experiment name, sample name
            id_str = ' and '.join([f'#{i}' for i in self.id_list])
            self.to_word(f'{id_str}. Exp: {self.exp_name}. Sample: {self.sample_name}\n')
            # measurement name
            self.to_word(f'{meas_list[0].name}\n')
            
            
            ##########################
            ##### start 2d scan  #####
            user_interrrupt = False
            self.is_fwd_now = True
            try:
                # initialize 'z' (not exists) and y0, wait for 1 s
                t0 = time.time()
                if para_y:
                    para_y(list_y[0])
                    time.sleep(1)

                for y in self.tqdm_y(list_y):
                    # Initialize y and x0, wait for delay_y seconds
                    if para_y:
                        para_y(y)
                    para_x(list_x[0])
                    time.sleep(dly_y)
                    
                    # 1d scan. 2 scans if backward scan is ON
                    # No matter 1 or 2 scans, list_x will keep the same after the for loop
                    for ds in datasaver_list:

                        t1 = time.time()
                        val_list = self._scan1d(ds, list_x, y)
                        t2 = time.time()

                        # will run 0 time or twice so values will be unchagned at last
                        if bwd:
                            list_x = list_x[::-1]
                            if self.is_fwd_now and self.scan_dim==1:
                                qclient_bwd = qtplot_client(self.mute_qclient)
                                qclient_bwd.init_temporary_file(datasaver_list[1].dataset,list_x,list_y)
                                qclient_bwd.update_plot()
                                # close after update_plot() so temporary file is not occupied
                                self.qclient.close()
                                self.qclient = qclient_bwd
                            self.is_fwd_now = not self.is_fwd_now

                t3 = time.time()
                time_str = f'{self.to_time_str(t0,t1,t2,t3)}'
                print(time_str)
                self.to_word(f'{time_str}\n')
            except KeyboardInterrupt:
                print('Exit manually')
                user_interrrupt = True
            ##### end 2d scan  #####
            ########################

            for ds in datasaver_list: 
                ds.flush_data_to_database()

            if self.export_dat:
                last_dat_path = self._export_dat(dat_folder = f'DAT')
                self.qclient.update_plot(last_dat_path)

            self.qclient.close()

            if user_interrrupt:
                sys.exit()
                
    def to_word(self, text, font_style=None):
        try:
            word = win32.Dispatch('word.application')
            doc_path = f'{qc.config.core.db_location[:-3]}.docx'
            if not os.path.isfile(doc_path):
                open(doc_path,'w').close()
            
            word.Visible = True
            doc = word.Documents.Open(os.path.abspath(doc_path))

            cend = doc.Content.End
            doc.Content.InsertAfter(text)
            # print(f"toWord: {text}")
            
            if font_style:
                doc.Content.InsertAfter('\n')
                r_start, r_end = cend-1,cend-1+len(text)
                rng_text = doc.Range(r_start, r_end)
                for i in font_style:
                    # rng_temporary_space = doc.Range(r_end, r_end+1)
                    if type(i) == int:
                        rng_text.Font.Size = i
                    elif i == 'bold':
                        rng_text.Font.Bold = True
                    elif i == 'blue':
                        rng_text.Font.ColorIndex = 2
                    elif i == 'red':
                        rng_text.Font.ColorIndex = 6
                    # rng_temporary_space.Text = ''

        except:
            print("toWord: Office WORD not available.")

class Db2Dat:
    '''
    Functions for converting DB data to DAT data
    '''

    def are_indexes_equal(self, df_dict):
        '''
        Check if all dataframes in the dictionary have the same index
        '''
        index_list = [i.index for i in df_dict.values()]
        # check index (array values)
        are_vals_equal = np.all([i==index_list[0] for i in index_list])
        # check index names
        index_names_list = [i.names for i in index_list]
        are_names_equal = np.all([i==index_names_list[0] for i in index_names_list])

        return are_vals_equal and are_names_equal

    def add_index_to_col(self, df):
        '''
        Add index to columns
        The first column is the index changes fastest.
        '''
        if len(df.index.names)>1:# more than 1 indexes
            ind_shape = df.index.levshape
            # df.index.levels[0]： values (list) of the first index
            if list(df.index.levels[0]) == [i[0] for i in df.index[:ind_shape[0]]] or list(df.index.levels[0])[::-1] == [i[0] for i in df.index[:ind_shape[0]]]:
                step = 1
            else:
                step = -1
            new_col_names = list(df.index.names)[::step] + list(df.columns)
            size_list = list(ind_shape[::step])
        else:
            new_col_names = list(df.index.names) + list(df.columns)
            size_list = [len(df.index)]

        # Convert index into normal columns
        df = df.reset_index()
        # Reset index columns so that first col changes fastest
        df = df.reindex(columns=new_col_names)
        return df,size_list


    def dataset_to_dataframe(self, dataset):

        para_names = [i for i in dataset.paramspecs]
        tlevel_para_names_sorted = [i.name for i in dataset._rundescriber.interdeps.top_level_parameters]
        tlevel_para_names_original = [i for i in para_names if i in tlevel_para_names_sorted]
        # w/o providing *tlevel_para_names_original the returned dict will be sorted by name strings
        df_dict = dataset.to_pandas_dataframe_dict(*tlevel_para_names_original)
        
        if self.are_indexes_equal(df_dict):
            # combine multiple dataframes of parameters into one
            df = pd.concat(df_dict.values(), axis='columns')
            df,size_list = self.add_index_to_col(df)
            return df,size_list
        else:
            raise('Indexes are not equal, check the dataset!')

    def get_dat_filename(self, dataset):
        # os.path.split(dataset.path_to_db)[-1][:-3], dataset.exp_name, dataset.sample_name, dataset.run_id
        return f'{dataset.exp_name}.{dataset.sample_name}.{dataset.run_id}.dat'

    def get_dat_meta(self, dataset, dataframe, size_list):
        paramspecs = dataset.paramspecs
        counter = 0
        meta_string = f'''\
# Filename: {self.get_dat_filename(dataset)}
# Timestamp: {dataset.run_timestamp()}

'''
        for name in dataframe.columns:
            p = paramspecs[name]
            label = f'{p.name}'
            if p.unit:
                label += f' ({p.unit})'
            meta_string += f'''\
# Column {counter+1}:
#\tname: {label}
'''
            if counter<len(size_list):
                meta_string += f'''\
#\tsize: {size_list[counter]}
'''
            elif counter<3:# otherwise qtplot won't import the data
                meta_string += f'''\
#\tsize: {1}
'''
            counter += 1
        meta_string += '\n'
        return meta_string

    def export_setting_file(self, dataset,folder='',overwrite=False):
        dat_path = self.get_dat_filename(dataset)
        settings_str = f'''\
Filename: {dat_path}
Timestamp: {dataset.run_timestamp()}

'''

        if 'instruments' in dataset.snapshot['station']:
            instr_dict = dataset.snapshot['station']['instruments']
            for ins_key, ins in instr_dict.items():
                settings_str += f'Instrument: {ins_key}\n'
                if 'address' in ins:
                    settings_str += f"\taddress: {ins['address']}\n"
                for para_key, para in ins['parameters'].items():
                    # for each parameter in the instrument we only export name and value
                    if 'value' in para:
                        settings_str += f"\t{para_key}: {para['value']}\n"
                settings_str += '\n'

        # qcodes also has standalone "parameters" in snapshot, 
        # however, in SET files parameters must be associated to an instrument
        if 'parameters' in dataset.snapshot['station']:
            instr_dict = dataset.snapshot['station']['parameters']
            for ins_key, ins in instr_dict.items():
                settings_str += f'Instrument: {ins_key}\n'
                # here ins is in fact a parameter
                for para_key, para in ins.items():
                    settings_str += f"\t{para_key}: {para}\n"
                settings_str += '\n'

        file_path = os.path.join(folder,dat_path.replace('.dat','.set'))
        if (not os.path.isfile(file_path)) or overwrite:
            # if file not exists or file exists but overwrite is true
            with open(file_path, 'w') as f:
                f.write(settings_str)
        else:
            print(f'File "{file_path}" already exists and has not been overwritten.')
        return file_path

    def export_dat_file(self,dataset,folder='',filename='',overwrite=False,force_size_list=None):
        df,size_list = self.dataset_to_dataframe(dataset)
        if force_size_list:
            size_list = force_size_list
        meta = self.get_dat_meta(dataset,df,size_list)
        if filename=='':
            filename = self.get_dat_filename(dataset)
        file_path = os.path.join(folder,filename)
        if (not os.path.isfile(file_path)) or overwrite:
            # if file not exists or file exists but overwrite is true
            with open(file_path, 'w') as f:
                f.write(meta)
                try:
                    df.to_csv(f, sep='\t', float_format='%.12e', lineterminator='\n', index=False, header=False)
                except:
                    # for old pandas
                    df.to_csv(f, sep='\t', float_format='%.12e', line_terminator='\n', index=False, header=False)
        else:
            print(f'File "{file_path}" already exists and has not been overwritten.')
        return file_path


    def to_dat(self, db_path, exp_id, dat_folder='',overwrite=False, quiet=False):
        initialise_or_create_database_at(db_path)
        dataset = qc.load_by_id(exp_id)
        dat_path = self.export_dat_file(dataset,dat_folder,'',overwrite)
        self.export_setting_file(dataset,dat_folder,overwrite)
        if not quiet:
            print(f'DAT and SET file saved: {dat_path[:-4]}')
        return dat_path
        
        
# see also https://github.com/cover-me/repository/blob/master/qt/qtlab%20scan%20scripts/Qscan.230520.py
class qtplot_client():
    '''A client for real-time plotting in qtplot'''
    def __init__(self,mute=False,interval=1):
        self.mute = mute # mute the client or not
        self.npy_path = ''
        self.lastfile = ''
        self.last_update_time = 0
        self.mdata = None# mmap data which is plotted by qtplot
        self.counter = 0# real-time row number
        self.interval = interval# minimum refresh interval for qtplot

    def _connect_qtplot(self):
        try:
            sckt = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sckt.connect(('127.0.0.1',1787))
            return sckt
        except Exception:
            return None

    def init_temporary_file(self,dataset,x_pts,y_pts):         
        if not self.mute:
            sckt = self._connect_qtplot()
            if sckt is None:
                self.mute = True
                print('Failed to reach qtplot. Mute the client.')
            else:
                sckt.close()
                
            nx, ny = len(x_pts), len(y_pts)
            row = nx*ny
            col = len(dataset.paramspecs)
            
            # Create a temporary NPY file for qtplot and use the mmap technique
            temp_folder = mkdtemp()
            self.npy_path = os.path.join(temp_folder, 'qtplot_temp.npy')
            
            # meta file is required since npy file doesn't contain metadata
            d2d = Db2Dat()
            d2d.export_dat_file(dataset,temp_folder,'qtplot_temp.meta.txt',overwrite=True,force_size_list=[nx,ny])
            
            # create the table and fill in X and Y columns
            m = np.full((row,col), np.nan)
            X = np.tile(x_pts,ny)
            Y = np.repeat(y_pts,nx)
            W = np.vstack([X,Y])
            m[:,:len(W)] = W.T

            np.save(self.npy_path,m)
            self.mdata = np.load(self.npy_path, mmap_mode='r+')

    def add_data(self,values):
        if not self.mute:
            self.mdata[self.counter,:] = values
            self.counter += 1

    def _update_plot(self, filepath=''):
        sckt = self._connect_qtplot()
        if sckt is not None: 
            if not filepath:
                filepath = self.npy_path
            if self.lastfile == filepath:
                sckt.send(f'REFR:{filepath}'.encode('ascii'))
            else:
                self.lastfile = filepath
                # sckt.send(f'FILE:{filepath};SHOW:'.encode('ascii'))
                sckt.send(f'FILE:{filepath}'.encode('ascii'))
                sckt.recv(128)
            sckt.close()
        else:
            self.mute = True
            print('Failed to reach qtplot. Mute the client.')
            
    def update_plot(self, filepath=''):
        if not self.mute:
            if filepath:
                self._update_plot(os.path.abspath(filepath))
            elif time.time()>(self.last_update_time+self.interval):
                self.last_update_time = time.time()
                self._update_plot()

    def close(self):
        if not self.mute:
            self.mute = True
        del self.mdata
        if self.npy_path:
            rmtree(os.path.split(self.npy_path)[0],ignore_errors=True)
