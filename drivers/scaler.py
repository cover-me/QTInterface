from qcodes import Instrument
from qcodes.parameters import Parameter, DelegateParameter
from qcodes.validators import Strings, Numbers
from qcodes.station import Station

class Scaler(Instrument):
    def __init__(self, name, address="", source=None, factor=1, unit=''):
        super().__init__(name)
        self.address = address

        self._dummy_source = Parameter("None", get_cmd=lambda: 0, set_cmd=lambda x: 0)

        self.add_parameter(
            name='source',
            unit=None,
            get_cmd=self._get_source,
            set_cmd=self._set_source,
            vals=Strings(),
        )
        self.source.metadata['gui'] = {
            'type':'parameter',
        }

        self.add_parameter(
            name='factor',
            unit=None,
            get_cmd=self._get_factor,
            set_cmd=self._set_factor,
            vals=Numbers(),
        )

        self.add_parameter(
            name='unit',
            unit=None,
            get_cmd=self._get_unit,
            set_cmd=self._set_unit,
            vals=Strings(),
        )

        self.add_parameter(
            name='scaled_value',
            source=self._dummy_source,
            scale=1,
            unit=None,
            parameter_class=DelegateParameter,
        )
        
        self.connect_message()

    def _para_str_to_para(self,para_str):
        if para_str.lower()=="none" or para_str=="":
            return self._dummy_source
        try:
            station = Station.default
            inst_name, param_name = para_str.split(".", maxsplit=1)
            inst = station.components[inst_name]
            p = getattr(inst,param_name)
            return p
        except Exception as e:
            print(f"VirtualDivider._para_str_to_para error: {e}")
    
    def update_vals(self):
        src_vals = self.scaled_value.source.vals
        if isinstance(src_vals, Numbers):
            vmin, vmax = src_vals.min_value, src_vals.max_value
            vmin = vmin*self.factor() if vmin is not None else None
            vmax = vmax*self.factor() if vmax is not None else None
            self.scaled_value.vals = Numbers(vmin, vmax)

    def _get_source(self):
        if self.scaled_value.source is self._dummy_source:
            return 'None'
        else:
            inst_str = self.scaled_value.source.root_instrument.name
            para_str = self.scaled_value.source.name
            return f'{inst_str}.{para_str}'

    def _set_source(self, source_str):
        p = self._para_str_to_para(source_str)
        self.scaled_value.source = p
        self.update_vals()

    def _get_factor(self):
        return 1/self.scaled_value.scale

    def _set_factor(self, factor):
        self.scaled_value.scale = 1/factor
        self.update_vals()

    def _get_unit(self):
        return self.scaled_value.unit

    def _set_unit(self, unit):
        self.scaled_value.unit = unit
        
    def _get_scaled_value(self):
        return self.scaled_value()

    def _set_scaled_value(self, val):
        self.scaled_value(val)
        
    def get_idn(self) -> dict[str, Optional[str]]:
        return {
            'vendor': 'QTInterface',
            'model': 'Scaler',
            'serial': '',
            'firmware': ''
        }

    def close(self):
        self.source("None")
        self.clear(echo=False)
        print(f"[{self.name}] Closing...")
        
    def clear(self, echo=True):
        if echo:
            print(f"[{self.name}] Clearing buffer...")