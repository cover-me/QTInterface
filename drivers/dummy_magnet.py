from typing import Any, Optional
from qcodes.instrument import Instrument
import qcodes.validators as vals
import random

class DummyMagnet(Instrument):
    def __init__(self, name: str, address, **kwargs: Any):
        super().__init__(name,** kwargs)
        self._field = 0.0
        self._ramp_rate = 0.0

        self.add_parameter(
            'field',
            unit='T',
            get_cmd=self._get_field,
            set_cmd=self._set_field,
            vals=vals.Numbers(-9, 9)
        )
        self.field.metadata["gui"] = {"ramp_rate_parameter": "ramp_rate"}

        self.add_parameter(
            'ramp_rate',
            unit='T/min',
            get_cmd=self._get_ramp_rate,
            set_cmd=self._set_ramp_rate,
            vals=vals.Numbers(1e-12, 0.2)
        )
        
        self.connect_message()

    def _set_field(self, val):
        # print(f"Setting {self.name}.field: {val}")
        self._field = val

    def _get_field(self):
        val = self._field + random.random() / 100
        # print(f"Getting {self.name}.field: {val}")
        return val

    def _set_ramp_rate(self, val):
        self._ramp_rate = val

    def _get_ramp_rate(self):
        return self._ramp_rate

    def get_idn(self) -> dict[str, Optional[str]]:
        return {
            'vendor': 'QTInterface Dummy',
            'model': 'Virtual Magnet',
            'serial': '',
            'firmware': ''
        }

    def close(self):
        super().close()
        self.clear(echo=False)
        print(f"[{self.name}] Closing...")

    def clear(self, echo=True):
        if echo:
            print(f"[{self.name}] Clearing buffer...")
