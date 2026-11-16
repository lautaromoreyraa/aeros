# aeros

Satellite fire early warning, built on 26 years of MODIS and VIIRS hotspots brought onto one scale. NASA FIRMS has recorded fire since 2000, but with sensors that see differently, so the count jumps when the fleet changes and not when the fire does. aeros removes that jump, shows what is normal for any area and month, and warns the people near a possible fire. It runs today on its first study region, in South America; the harmonization never uses location as a model feature, so it is not tied to that region.

- Live: https://aer-os.health
- Challenge: NASA Space Apps Challenge 2026, **Harmonization of MODIS and VIIRS Hot Spots**
- Team: Lautaro and David
- Plan, results and status: [`plan.md`](plan.md)

## What it does

| For | aeros gives |
|---|---|
| Anyone asking whether a season was worse | One harmonized record, 2000 to today, with a 90 % interval for any area and period |
| Fire brigades, land managers, local governments | A calendar of burning activity by month and year, the anomaly against the history, the critical months, and a CSV |
| People who live there | A message by SMS, Telegram or e-mail when an anomalous fire risk is detected near their location |

- **Visual Story Deck**: [`slides/visual-deck.html`](slides/visual-deck.html) (1080p slide deck covering the planetary problem, data crossing, and multi-channel warning matrix)
- **Interactive Pitch Deck**: [`slides/index.html`](slides/index.html)
- **Detailed System Architecture**: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- What is live today and what still waits for a deploy step is in section 6 of [`plan.md`](plan.md).

## Architecture and Data Flow

Aeros integrates 26 years of NASA satellite observations, machine learning risk projections, and AWS serverless computing to deliver early warnings across multiple channels.

```mermaid
flowchart TB
  subgraph ingestion["1. Satellite Ingestion & Environmental Data"]
    direction TB
    FIRMS["NASA FIRMS<br/>26-Year MODIS Terra/Aqua (1000m)<br/>VIIRS SNPP/NOAA-20/21 (375m)"]
    GOES["NOAA GOES-19 ABI<br/>L2 Fire Detection (ABI-L2-FDCF)<br/>10-minute cadence"]
    METEO["Weather & Fuel Dryness<br/>Open-Meteo ERA5 Reanalysis<br/>NASA POWER Surface Meteorology"]
  end

  subgraph analytics["2. Harmonization & Modeling Engine"]
    direction TB
    H3["Discrete Global Grid System<br/>Uber H3 Spatial Resampling (Res 5–7)<br/>Equal-area hexagon aggregation"]
    CALIB["Sensor Neutralization<br/>Corrects +230% artificial sensor shift<br/>26-year baseline distributions"]
    POISSON["Statistical Anomaly Detector<br/>Poisson Tail Probability (p < 0.01)<br/>Flags counts > 2x historical median"]
    GBM["ML Predictive Forecaster<br/>Gradient Boosting (scikit-learn)<br/>1–4 week ahead fire risk projection"]
  end

  subgraph cloud["3. Serverless Cloud Infrastructure (AWS Free-Tier Compliant)"]
    direction TB
    EB["Amazon EventBridge<br/>Automated 10-minute triggers"]
    LAMBDA["AWS Lambda (arm64, 512MB)<br/>Stateless execution & proximity matching"]
    DDB["Amazon DynamoDB<br/>Single-table subscriber store<br/>Geodesic 15km radius filtering"]
    S3CF["Amazon S3 + CloudFront<br/>Global edge cache & static hosting"]
  end

  subgraph dispatch["4. Multichannel Warning Delivery Matrix"]
    direction TB
    SMS["SMS Gateway (Twilio / httpSMS)<br/>160-char high-urgency message<br/>Zero-data & low-connectivity rural zones"]
    TG["Telegram Bot Service<br/>Interactive alerts with coordinates,<br/>wind heading, and risk level cards"]
    SES["Amazon SES Email<br/>Full operational situational report<br/>for land managers and civil defense"]
  end

  subgraph frontend["5. Interactive 3D Digital Twin & Dashboard"]
    direction TB
    TWIN["3D Planetary Globe (Three.js 4K)<br/>Terrain Map (MapLibre GL)<br/>Wind vector overlays & cell drilldown"]
  end

  FIRMS --> H3
  H3 --> CALIB
  CALIB --> POISSON
  METEO & CALIB --> GBM
  GOES --> LAMBDA
  POISSON & GBM --> LAMBDA
  EB --> LAMBDA
  LAMBDA <--> DDB
  LAMBDA --> SMS & TG & SES
  CALIB & GBM & GOES --> S3CF
  S3CF --> TWIN
```

### Multichannel Alert Routing

Alert delivery is customized to the user's infrastructure constraints:

```mermaid
flowchart TD
  TRIGGER["Real-Time Anomaly Trigger<br/>GOES-19 hotspot or Poisson p < 0.01"] --> COORD["Extract Event Centroid & Radiative Power (MW)"]
  COORD --> QUERY["Query DynamoDB Subscriptions"]
  QUERY --> GEO{"Geodesic Distance &le; 15 km?"}
  GEO -- "No" --> DISCARD["Suppress (Prevent alert fatigue)"]
  GEO -- "Yes" --> ROUTE{"Selected Delivery Channel"}

  ROUTE -- "SMS" --> C_SMS["SMS Gateway (Twilio / httpSMS)<br/>160-char text optimized for low connectivity<br/>Works without internet or data coverage"]
  ROUTE -- "Telegram" --> C_TG["Telegram Bot (@AerosAlertBot)<br/>Rich card with coordinates, wind vector,<br/>and emergency checklist"]
  ROUTE -- "Email" --> C_EMAIL["Amazon SES Email<br/>Full briefing with meteorological context,<br/>historical comparison, and response checklist"]

  C_SMS --> RECV1["Rural Residents & Field Volunteer Crews"]
  C_TG --> RECV2["Local Brigades & Command Coordinators"]
  C_EMAIL --> RECV3["Civil Defense & Environmental Authorities"]
```

## Run it

```bash
# The pipeline on a synthetic archive with known truth
cd model && python -m pip install -e ".[dev]" && python -m aeros demo   # ten to fifteen minutes

# The web app
cd web && npm ci && npm run dev
```

Every pull request runs `.github/workflows/verify.yml` on Python 3.12 and Node 24. Its main checks by hand:

```bash
cd model && ruff check . && python -m pytest -q
cd web && npm ci && npm test && npm run build
cd infra/aws && npm ci && npm run build && npm test && npx cdk synth --quiet
cd infra/mcp && npm ci && npx tsc --noEmit && npx vitest run
```

| Path | Contents |
|---|---|
| `model/` | Python package `aeros`: FIRMS ingestion, grid, reference chain, translators, validation, calendar, command line |
| `web/` | React and TypeScript client: landing page and dashboard |
| `infra/aws/` | AWS CDK stacks and the Python functions behind the API and the alerts |
| `infra/mcp/` | The team context server every assistant reads and writes |
| `prompts/` | The prompts that steered the product |
| `slides/` | Standalone interactive pitch deck and 1080p visual presentation |
| `docs/` | System architecture documentation and visual storytelling assets |

## How AI was used

Two people built aeros, each directing coding assistants. The code, tests and documentation in this repository were written with those assistants; the people decided what to build and checked the result. Lautaro works with Claude. David works with Devin, and used Grok and Antigravity for a few side tasks: connecting the assistants to the team server, the rule that closes each task with its own push, and download scripts that are not in the repository.

The people chose the challenge, the regions, the weather source, the account it runs on and the alert policy, and Lautaro approves every merge.

```mermaid
flowchart TB
  subgraph people["People decide"]
    D["David<br/>web, data, deploy"]
    L["Lautaro<br/>model, infrastructure,<br/>merges"]
  end
  subgraph steer["Steering prompts, kept in prompts/README.md"]
    S["Scope<br/>P-001, P-002,<br/>P-006"]
    A["Data and<br/>architecture<br/>P-003, P-009,<br/>P-010"]
    P["Presentation<br/>P-004, P-005,<br/>P-008, P-013"]
    Q["Quality and<br/>process<br/>P-007, P-011,<br/>P-012"]
  end
  subgraph write["Assistants write"]
    DV["Devin"]
    GA["Grok and<br/>Antigravity<br/>side tasks"]
    CL["Claude"]
  end
  HUB["Team context server<br/>claims, conventions,<br/>decisions, progress"]
  subgraph made["What they wrote"]
    W["web/<br/>Devin and Claude"]
    M["model/<br/>Claude and Devin"]
    I["infra/<br/>Claude, deployed<br/>by Devin"]
    X["data and docs<br/>Devin and Claude"]
  end
  subgraph checks["Checks before it merges"]
    CI["verify workflow<br/>lint, types, tests,<br/>build, cdk synth"]
    PR["Pull request<br/>approved by Lautaro"]
  end
  LIVE["aeros<br/>no generative AI<br/>at run time"]
  D --> S & A & P & Q
  S & A & P & Q --> DV
  D -..-> GA
  L -- "his prompts are not<br/>in the record yet" ---> CL
  write <--> HUB
  write --> made
  made --> CI
  CI --> PR
  PR --> LIVE
```

| Where | What the assistants did | What a person decided or checked |
|---|---|---|
| Choosing the challenge | Compared the challenges on technical demand, room for machine learning, impact and the risk of not finishing (P-001) | The team chose that challenge |
| `model/` | Wrote the pipeline, its tests and the validation runs | The regions (P-002), keeping the whole archive (P-003) and NOAA-21 in the reference chain |
| `web/` | Wrote the landing, the dashboard and the copy | David reviewed in the browser and corrected, down to the facts (P-007) |
| `infra/` | Wrote the stacks, the functions, their tests and the team server, and ran the deploy | The account (P-010), the Free plan limits and the alert policy |
| Data | Downloaded and verified the FIRMS archive | What to keep (P-003) and how long jobs run (P-011); David ordered part of the archive by hand |
| Research and writing | Read NASA, AWS and Google Cloud documentation; wrote commits, pull requests and these documents; turned prompts written in Spanish into English artifacts | Lautaro approves every pull request before it merges |

What to know when reading the history:

- Commits carry no assistant signature, by team convention. Read every commit as written with an assistant.
- Nothing generative runs in the product. The harmonization is a ratio rule corrected by gradient boosting, and the weekly forecast is gradient boosting too (scikit-learn), both trained by the pipeline; the early warning is a statistical test against the same days of earlier years; alert messages are fixed text filled with numbers.
- The assistants coordinate through the team context server: each one claims a task before touching its files and logs what it did.
- The prompts that changed the course are in [`prompts/README.md`](prompts/README.md), each with its situation, the decision and where it landed. The diagram cites them by id.

## Data and credits

| Source | Used for |
|---|---|
| NASA FIRMS: MODIS Collection 6.1 (Terra, Aqua) and VIIRS 375 m (Suomi NPP, NOAA-20, NOAA-21), standard and near real time | The harmonized record and the daily early warning |
| GOES-19 ABI fire product (ABI-L2-FDCF), NOAA Open Data Dissemination | The fire layer that refreshes every 10 minutes and the alert to subscribers |
| Open-Meteo forecast and archive (CC BY 4.0), with ERA5 from Copernicus | Wind and fire weather |
| NASA POWER | Fuel dryness and fire weather in the weekly forecast |
| RESOLVE Ecoregions 2017 (CC BY 4.0) and geoBoundaries | Region outlines |
| NASA Visible Earth (Blue Marble, Black Marble), clouds from Solar System Scope (CC BY 4.0), Esri World Imagery | The globe and the satellite basemap |
