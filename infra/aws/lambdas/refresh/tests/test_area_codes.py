import pytest

import area_codes

AREA = (-69.0, -35.0, -53.0, -16.0)


@pytest.mark.parametrize(
    ("phone", "town"),
    [
        ("+5493624000000", "Resistencia"),
        ("+543624000000", "Resistencia"),  # written without the mobile 9
        ("+5493644000000", "Presidencia Roque Sáenz Peña"),
        ("+5493794000000", "Corrientes"),
        ("+5493725400000", "General José de San Martín"),
        ("+5491140000000", "Buenos Aires"),
        ("+5493874000000", "Salta"),
        ("+5493873400000", "Tartagal"),  # the longer code wins over 387
    ],
)
def test_the_area_code_of_an_argentine_number_names_its_town(phone, town):
    assert area_codes.town_of(phone)["name"] == town


@pytest.mark.parametrize(
    "phone",
    ["+14155550100", "+5492994000000", "+549362400000", "+54936240000000", "", "3624000000"],
)
def test_a_foreign_number_an_unknown_code_or_a_wrong_length_names_no_town(phone):
    assert area_codes.town_of(phone) is None


def test_every_code_has_two_to_four_digits_and_its_town_is_inside_the_area():
    west, south, east, north = AREA
    for code, (_name, _region, lat, lng) in area_codes._TOWNS.items():
        assert code.isdigit() and len(code) in area_codes._CODE_LENGTHS, code
        assert west <= lng <= east and south <= lat <= north, code
