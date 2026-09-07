from typing import Any, Optional
from qcodes.instrument import Instrument
import qcodes.validators as vals
import random

class DummyVoltageSource(Instrument):
    def __init__(self, name: str, address, **kwargs: Any):
        super().__init__(name, **kwargs)
        self._voltage: float = 0.0
        self.add_parameter(
            'voltage',
            label='Output Voltage',
            unit='V',
            get_cmd=self._get_voltage,
            set_cmd=self._set_voltage,
            vals=vals.Numbers(-10.0, 10.0)
        )
        self.connect_message()

    def _set_voltage(self, val: float) -> None:
        # print(f"Setting {self.name}.voltage: {val}")
        self._voltage = float(val)

    def _get_voltage(self) -> float:
        val = self._voltage + random.random() / 100
        # print(f"Getting {self.name}.voltage: {val}")
        return val

    def get_idn(self) -> dict[str, Optional[str]]:
        return {
            'vendor': 'QTInterface',
            'model': 'Virtual Voltage Source',
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
