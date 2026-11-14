"""Area of interest -> H3 cells at the resolution of the harmonized panel.

A cell belongs to the area when its center falls inside, the rule the model
uses (`aeros.grid.cells_in_polygon`), so a calendar here adds up exactly like
the pipeline's own. An area smaller than one cell would select nothing by that
rule; it falls back to every cell it touches, so a farm still gets the cell
around it.
"""

from __future__ import annotations

import h3


class AreaTooLarge(ValueError):
    pass


def cells_for(geometry: dict, resolution: int, max_cells: int) -> list[str]:
    shape = h3.geo_to_h3shape(geometry)
    cells = h3.h3shape_to_cells(shape, resolution)
    if not cells:
        cells = h3.h3shape_to_cells_experimental(shape, resolution, contain="overlap")
    if len(cells) > max_cells:
        raise AreaTooLarge(
            f"area covers {len(cells)} cells; the limit is {max_cells}, draw a smaller area"
        )
    return sorted(cells)
