"""The town a phone number belongs to, read from its area code.

An SMS sign-up may come with no town: the person typed a number and nothing
else. An Argentine number starts with the area code of the place where the line
was issued, so that place stands in for the town until the person names one.
It is where the line was issued, not where the phone is: the welcome text names
the town, so a person somewhere else can see it and sign up again with theirs.

Argentine area codes have two, three or four digits. A long code can begin
with the digits of a short one (3873 is Tartagal, 387 is Salta), and the
numbering plan keeps them apart by never giving Salta a line that starts with
that extra digit. So the longest code that matches is the right one. The table
holds the codes of the cities inside the monitored area that the team could
check, not every code of the country: a number whose code is not here gets no
town, and the sign-up asks for one.

Coordinates are the town's centre to a hundredth of a degree, as a
subscription keeps them. Nothing here talks to the network.
"""

from __future__ import annotations

COUNTRY_PREFIX = "+54"
NATIONAL_DIGITS = 10
#: Mobile numbers written from abroad carry this digit between the country and the area code.
MOBILE_MARK = "9"

_CHACO = "Provincia del Chaco"
_CORRIENTES = "Provincia de Corrientes"
_MISIONES = "Provincia de Misiones"
_SALTA = "Provincia de Salta"
_SANTA_FE = "Provincia de Santa Fe"
_CORDOBA = "Provincia de Córdoba"
_ENTRE_RIOS = "Provincia de Entre Ríos"
_BUENOS_AIRES = "Provincia de Buenos Aires"

#: area code -> (town, province, latitude, longitude)
_TOWNS: dict[str, tuple[str, str, float, float]] = {
    "11": ("Buenos Aires", "Ciudad Autónoma de Buenos Aires", -34.61, -58.38),
    "221": ("La Plata", _BUENOS_AIRES, -34.92, -57.95),
    "261": ("Mendoza", "Provincia de Mendoza", -32.89, -68.84),
    "264": ("San Juan", "Provincia de San Juan", -31.54, -68.54),
    "266": ("San Luis", "Provincia de San Luis", -33.30, -66.34),
    "336": ("San Nicolás de los Arroyos", _BUENOS_AIRES, -33.33, -60.21),
    "341": ("Rosario", _SANTA_FE, -32.95, -60.64),
    "342": ("Santa Fe", _SANTA_FE, -31.63, -60.70),
    "343": ("Paraná", _ENTRE_RIOS, -31.73, -60.53),
    "345": ("Concordia", _ENTRE_RIOS, -31.39, -58.02),
    "351": ("Córdoba", _CORDOBA, -31.42, -64.18),
    "353": ("Villa María", _CORDOBA, -32.41, -63.24),
    "358": ("Río Cuarto", _CORDOBA, -33.12, -64.35),
    "362": ("Resistencia", _CHACO, -27.46, -58.99),
    "364": ("Presidencia Roque Sáenz Peña", _CHACO, -26.79, -60.44),
    "370": ("Formosa", "Provincia de Formosa", -26.18, -58.17),
    "376": ("Posadas", _MISIONES, -27.37, -55.90),
    "379": ("Corrientes", _CORRIENTES, -27.47, -58.83),
    "380": ("La Rioja", "Provincia de La Rioja", -29.41, -66.86),
    "381": ("San Miguel de Tucumán", "Provincia de Tucumán", -26.82, -65.22),
    "383": ("San Fernando del Valle de Catamarca", "Provincia de Catamarca", -28.47, -65.78),
    "385": ("Santiago del Estero", "Provincia de Santiago del Estero", -27.80, -64.26),
    "387": ("Salta", _SALTA, -24.79, -65.41),
    "388": ("San Salvador de Jujuy", "Provincia de Jujuy", -24.19, -65.30),
    "3442": ("Concepción del Uruguay", _ENTRE_RIOS, -32.48, -58.24),
    "3446": ("Gualeguaychú", _ENTRE_RIOS, -33.01, -58.52),
    "3482": ("Reconquista", _SANTA_FE, -29.15, -59.65),
    "3492": ("Rafaela", _SANTA_FE, -31.25, -61.49),
    "3564": ("San Francisco", _CORDOBA, -31.43, -62.08),
    "3718": ("Clorinda", "Provincia de Formosa", -25.28, -57.72),
    "3725": ("General José de San Martín", _CHACO, -26.54, -59.34),
    "3731": ("Charata", _CHACO, -27.21, -61.19),
    "3735": ("Villa Ángela", _CHACO, -27.57, -60.71),
    "3751": ("Eldorado", _MISIONES, -26.40, -54.63),
    "3755": ("Oberá", _MISIONES, -27.49, -55.12),
    "3757": ("Puerto Iguazú", _MISIONES, -25.60, -54.57),
    "3772": ("Paso de los Libres", _CORRIENTES, -29.71, -57.09),
    "3777": ("Goya", _CORRIENTES, -29.14, -59.26),
    "3873": ("Tartagal", _SALTA, -22.52, -63.80),
    "3878": ("San Ramón de la Nueva Orán", _SALTA, -23.13, -64.32),
}
#: Longest first: see the module note on 3873 and 387.
_CODE_LENGTHS = (4, 3, 2)


def national_number(phone: str) -> str | None:
    """The ten digits after the country code of an Argentine number, else None."""
    if not phone.startswith(COUNTRY_PREFIX):
        return None
    digits = phone[len(COUNTRY_PREFIX) :]
    if len(digits) == NATIONAL_DIGITS + 1 and digits.startswith(MOBILE_MARK):
        digits = digits[1:]
    return digits if len(digits) == NATIONAL_DIGITS and digits.isdigit() else None


def town_of(phone: str) -> dict | None:
    """The town of the area code of a number in international form, as a place, else None."""
    number = national_number(phone)
    if number is None:
        return None
    for length in _CODE_LENGTHS:
        found = _TOWNS.get(number[:length])
        if found:
            name, region, lat, lng = found
            return {"name": name, "region": region, "country": "Argentina", "lat": lat, "lng": lng}
    return None
