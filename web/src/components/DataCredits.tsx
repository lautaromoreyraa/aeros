/**
 * Every outside source behind the app, credited the way each one asks:
 * FIRMS with NASA's acknowledgement, GOES as derived NOAA data (never as
 * NOAA's own product), Open-Meteo with its link and licence, and Copernicus
 * for the ERA5 reanalysis the fire-weather ranks are measured against, and
 * GeoNames for the towns a cell is named after.
 */
export function DataCredits() {
  return (
    <div className="credits">
      <p>
        Fire detections: we acknowledge the use of data from NASA's{" "}
        <a className="credit-link" href="https://www.earthdata.nasa.gov/data/tools/firms">
          Fire Information for Resource Management System (FIRMS)
        </a>
        , part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) and Earth Science
        Data and Information System (ESDIS): MODIS Collection 6.1 and VIIRS 375 m on Suomi NPP, NOAA-20 and NOAA-21.
      </p>
      <p>
        The fast fire watch is derived from NOAA's GOES-19 ABI Fire/Hot Spot Characterization product (ABI-L2-FDCF),
        accessed through the{" "}
        <a className="credit-link" href="https://registry.opendata.aws/noaa-goes/">
          NOAA Open Data Dissemination program on AWS
        </a>
        .
      </p>
      <p>
        <a className="credit-link" href="https://open-meteo.com/">
          Weather data by Open-Meteo.com
        </a>
        , under{" "}
        <a className="credit-link" href="https://creativecommons.org/licenses/by/4.0/">
          CC BY 4.0
        </a>
        : the wind layer comes from its forecast, and the fire-weather index and its ranks are computed from its forecast
        and ERA5 archive. Contains modified Copernicus Climate Change Service information 2026; neither the European
        Commission nor ECMWF is responsible for any use of it.
      </p>
      <p>
        Place names:{" "}
        <a className="credit-link" href="https://www.geonames.org/">
          GeoNames
        </a>
        , under{" "}
        <a className="credit-link" href="https://creativecommons.org/licenses/by/4.0/">
          CC BY 4.0
        </a>
        .
      </p>
    </div>
  );
}
