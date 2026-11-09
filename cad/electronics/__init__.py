"""
Electronics in a printed model (docs/cad.md, "Mạch điện tử"; Claude's guide: /opt/cad/electronics.md): off-the-shelf
modules as parts (catalog.py, geometry.py), the case's standoffs, cradles and port openings, and the wires of the
circuit between them (wiring.py). circuit.py checks and simulates the circuit at every build.

    python -m electronics        lists the modules, their ports and pins
"""

from .catalog import MODULES, describe
from .geometry import board_bottom, cradle, module, pin, port_cutout, standoffs
from .wiring import routes, wires

__all__ = ["MODULES", "describe", "module", "pin", "port_cutout", "standoffs", "cradle", "board_bottom", "wires",
           "routes"]
