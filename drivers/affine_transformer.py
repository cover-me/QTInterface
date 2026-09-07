from typing import Optional, Sequence, Sized, Callable
from numbers import Number as NumberType

import numpy as np
from functools import partial

from qcodes import Instrument, Station
from qcodes.parameters import Parameter
from qcodes import validators as vals
from qcodes.dataset.threading import process_params_meas


class VectorValidator(vals.Validator):
    def __init__(self, min_arr, max_arr, max_norm: Optional[float] = None):
        super().__init__()
        self.min_arr = np.asarray(min_arr).copy()
        self.max_arr = np.asarray(max_arr).copy()
        self.max_norm = max_norm
        self.num_components = len(self.min_arr)

        if len(self.min_arr) != len(self.max_arr):
            raise ValueError("min_arr and max_arr length mismatch")

    def validate(self, value, context: str = "") -> None:
        arr = np.asarray(value)
        expect_shape = (self.num_components,)
        if arr.shape != expect_shape:
            raise ValueError(f"{context}: shape {arr.shape}, expect {expect_shape}")

        if np.any(arr < self.min_arr) or np.any(arr > self.max_arr):
            raise ValueError(f"{context}: value out of range")

        if self.max_norm is not None:
            norm = np.linalg.norm(arr)
            if norm > self.max_norm:
                raise ValueError(f"{context}: norm {norm:.4f} > max {self.max_norm}")


class AffineParameter(Parameter):
    def __init__(self, name, instrument, component_dict=None, max_norm=None, **kwargs):
        super().__init__(name=name, instrument=instrument, **kwargs)
        self._component_dict = dict(component_dict) if component_dict is not None else {}
        self._max_norm = max_norm
        self.on_component_change()

    def on_component_change(self):
        component_dict = self._component_dict
        if not component_dict:
            self.vals = vals.Anything()
            self.unit = None
            self.inter_delay = 0
            self.step = None
            return

        for i in component_dict:
            self.unit = component_dict[i].unit
            break

        min_arr = np.array([component_dict[i].vals.min_value for i in component_dict])
        max_arr = np.array([component_dict[i].vals.max_value for i in component_dict])
        self.vals = VectorValidator(min_arr, max_arr, self._max_norm)

        self.inter_delay = max(p.inter_delay for p in component_dict.values())
        steps_list = [p.step for p in component_dict.values() if p.step is not None]
        self.step = None if len(steps_list) == 0 else min(steps_list)

        # WARNING: destructive side‑effect: modify external parameter inter_delay / step
        for p in component_dict.values():
            p.inter_delay = self.inter_delay
            p.step = self.step

    def add_component(self, name, para):
        self._component_dict[name] = para
        self.on_component_change()

    def remove_last_component(self):
        if self._component_dict:
            self._component_dict.popitem()
        self.on_component_change()

    def _get_value(self):
        if not self._component_dict:
            return np.array([])
        params_list = list(self._component_dict.values())
        pairs_list = process_params_meas(params_list, use_threads=True)
        vals_dict = {p: v for p, v in pairs_list}
        return np.asarray([vals_dict[p] for p in params_list])

    def _set_value(self, vals_arr):
        for param, val in zip(self._component_dict.values(), vals_arr):
            param.set(val)

    def get_ramp_values(
        self, value: Sized, step: Optional[NumberType] = None
    ) -> Sequence[Sized]:
        if step is None:
            return [value]
        if self.get_latest() is None:
            self.get()
        start_value = self.get_latest()
        dist = np.linalg.norm(value - start_value)
        step_abs = abs(step)
        if step_abs > dist:
            return [value]
        step_count = np.ceil(dist / step_abs) + 1
        return np.linspace(start_value, value, step_count)[1:]


class AffineTransformer(Instrument):
    def __init__(self, name, address=""):
        super().__init__(name)
        self.address = address

        self._dimension = 0
        self.get_dimension: Callable[[], int] = lambda: self._dimension
        self._src_reference = np.array([])
        self._dst_value = np.array([])
        self._matrix = np.empty((0, 0))
        self._inv_matrix: Optional[np.ndarray] = None
        self._updating = False

        self.add_parameter(
            name="name_list",
            unit=None,
            get_cmd=self._get_name_list,
            set_cmd=False,
            vals=vals.Lists(vals.Strings()),
        )

        self.add_parameter(
            name="src_value",
            unit=None,
            get_cmd=self._get_src_value,
            set_cmd=self._set_src_value,
            parameter_class=AffineParameter,
        )
        self.src_value.metadata["gui"] = {"reload_after_set": True}

        # Arrays shape accepts callable; evaluated at validate time, not init time
        self.add_parameter(
            name="src_reference",
            unit=None,
            get_cmd=lambda: self._src_reference,
            set_cmd=self._set_src_reference,
            vals=vals.Arrays(shape=(self.get_dimension,)),
            initial_cache_value=np.array([]),
        )
        self.src_reference.metadata["gui"] = {"reload_after_set": True}

        self.add_parameter(
            name="matrix",
            unit=None,
            get_cmd=lambda: self._matrix,
            set_cmd=self._set_matrix,
            vals=vals.Arrays(
                shape=(self.get_dimension, self.get_dimension)
            ),
            initial_cache_value=np.empty((0, 0)),
        )
        self.matrix.metadata["gui"] = {"reload_after_set": True}

        self.add_parameter(
            name="inv_matrix",
            unit=None,
            get_cmd=lambda: self._inv_matrix,
            set_cmd=False,
            vals=vals.Arrays(
                shape=(self.get_dimension, self.get_dimension)
            ),
            initial_cache_value=np.empty((0, 0)),
        )

        self.add_parameter(
            name="src_component",
            unit=None,
            get_cmd=None,
            set_cmd=None,
            vals=vals.Strings(),
        )
        self.src_component.metadata["gui"] = {"type": "parameter"}

        self.add_parameter(
            name="action",
            unit=None,
            get_cmd=None,
            set_cmd=self._set_action,
            vals=vals.Enum("add_src_component", "remove_last"),
            initial_cache_value="add_src_component",
        )
        self.action.metadata["gui"] = {
            "reload_after_set": True,
            "type": "enum",
            "values": list(self.action.vals.valid_values),
        }
        
        self.connect_message()
        
    def find_para_by_string(self, para_str: str):
        try:
            station = Station.default
            inst_name, param_name = para_str.split(".")
            if inst_name == self.name:
                return None
            inst = station.components[inst_name]
            return getattr(inst, param_name)
        except Exception:
            return None

    def _set_action(self, action_str):
        func_name = f"_action_{action_str}"
        if hasattr(self, func_name):
            getattr(self, func_name)()

    def _set_src_reference(self, src_reference):
        self._src_reference = src_reference
        self._update_dst_value()

    def _set_matrix(self, matrix):
        self._matrix = matrix
        try:
            self._inv_matrix = np.linalg.inv(matrix)
        except np.linalg.LinAlgError:
            self._inv_matrix = None
        self._update_dst_value()

    def _get_src_value(self):
        return self.src_value._get_value()

    def _set_src_value(self, src_value):
        self.src_value._set_value(src_value)
        self._update_dst_value()

    def _get_out_component(self, idx: int):
        return self._dst_value[idx]

    def _set_out_component(self, val, idx: int):
        if self._inv_matrix is not None:
            self._dst_value[idx] = val
            self._update_src_value()
        else:
            print(f"[{self.name}] WARNING: inv_matrix is None, skip setting")

    def _update_dst_value(self):
        if self._updating:
            return
        self._updating = True
        try:
            src_value = self.src_value()
            src_reference = self.src_reference()
            matrix = self.matrix()
            dst_value = matrix @ (src_value - src_reference)
            self._dst_value = dst_value
            # WARNING: para(j) triggers parameter set; guarded by _updating flag against recursion
            for i, j in enumerate(dst_value):
                para = self.parameters[f"o{i+1}"]
                para(j)
        except Exception as e:
            print(f"[{self.name}] _update_dst_value error: {e}")
        finally:
            self._updating = False

    def _update_src_value(self):
        if self._updating:
            return
        self._updating = True
        try:
            dst_value = self._dst_value
            src_reference = self.src_reference()
            inv_matrix = self._inv_matrix
            src_value = inv_matrix @ dst_value + src_reference
            self.src_value(src_value)
        except Exception as e:
            print(f"[{self.name}] _update_src_value error: {e}")
        finally:
            self._updating = False

    def _action_add_src_component(self):
        p = self.find_para_by_string(self.src_component())
        if not (p and p.vals and p.vals.is_numeric):
            return

        self._dimension += 1
        self._updating = True
        name = p.full_name
        self.src_value.add_component(name, p)
        self.src_value()

        ref = np.pad(self.src_reference(), pad_width=((0, 1),), mode="constant", constant_values=0)
        self.src_reference(ref)

        mat = np.pad(self.matrix(), pad_width=((0, 1), (0, 1)), mode="constant", constant_values=0)
        mat[-1, -1] = 1
        self.matrix(mat)

        self.add_parameter(
            name=f"o{self._dimension}",
            unit=None,
            get_cmd=partial(self._get_out_component, idx=self._dimension - 1),
            set_cmd=partial(self._set_out_component, idx=self._dimension - 1),
            vals=vals.Numbers(),
            metadata={"gui": {"reload_after_set": True}},
        )
        self._updating = False
        self._update_dst_value()

    def _action_remove_last(self):
        if self._dimension <= 0:
            return
        self._dimension -= 1
        self._updating = True
        
        self.src_value.remove_last_component()
        self.src_value()

        self.src_reference(self.src_reference()[:-1].copy())
        self.matrix(self.matrix()[:-1, :-1].copy())
        self.remove_parameter(f"o{self._dimension + 1}")
        
        self._updating = False
        self._update_dst_value()

    def _get_name_list(self):
        return list(self.src_value._component_dict.keys()) if self.src_value._component_dict else []

    def get_idn(self) -> dict[str, Optional[str]]:
        return {
            "vendor": "QTInterface",
            "model": "AffineTransformer",
            "serial": "",
            "firmware": "",
        }

    def close(self):
        super().close()
        self.clear(echo=False)
        print(f"[{self.name}] Closing...")

    def clear(self, echo=True):
        if echo:
            print(f"[{self.name}] Clearing buffer...")
