# Steering prompts

The prompts from David and Lautaro that changed what aeros is or how it was built. Each one keeps the person's own words, the situation it answered, the decision taken and where it landed. It is a record of the course, a handful per working session, not of every message.

`README.md` at the root uses this file to declare how AI was used: the diagram there cites these entries by their id.

## Add an entry

1. Add it in the same branch as the change the prompt produced, right after acting on it.
2. Take the next id and fill every field of the table below.
3. Quote the person's own words, trimmed to the instruction that mattered, and add the English reading when they are not in English.
4. Leave out credentials and other people's personal data.

| Field | What goes in it |
|---|---|
| Id | `P-` and the next number; never reused, so other files can cite it |
| Date | Local day of the prompt (UTC-3) |
| Category | `scope`, `architecture`, `data`, `process`, `quality`, `security` or `presentation` |
| Importance | 3 redirected the product, 2 shaped a feature or a process, 1 refined something |
| Prompted by, via | The person who wrote it, and the assistant that received it |
| Situation | What was true before the prompt |
| Decision | What was decided because of it, and by whom when it was not the author |
| Impact | What exists now because of it |
| References | Pull requests, team decisions, files |

These are the fields of the `steering_prompts` table of the team context server (`infra/mcp/migrations/0006_steering_prompts.sql`). That log is written and tested but not deployed; when it is, these entries go into it and its `steering_study` tool renders the study from them.

## The record

| Id | Date | By | Category | Importance | Prompt |
|---|---|---|---|---|---|
| [P-001](#p-001) | 2026-11-13 | David | scope | 3 | Rank the challenges without agreeing with me |
| [P-002](#p-002) | 2026-11-14 | David | scope | 3 | Gran Chaco, Corrientes and Paraguay are the first regions |
| [P-003](#p-003) | 2026-11-14 | David | data | 3 | We do not trim the data |
| [P-004](#p-004) | 2026-11-14 | David | presentation | 3 | Sell it as an early-warning agent |
| [P-005](#p-005) | 2026-11-14 | David | presentation | 2 | The panel floats and never covers the map |
| [P-006](#p-006) | 2026-11-14 | David | scope | 3 | Warn the people in the risk zone, and bring the wind in |
| [P-007](#p-007) | 2026-11-14 | David | quality | 1 | It is 26 years, not 28 |
| [P-008](#p-008) | 2026-11-14 | David | presentation | 2 | A full brief for the hero instead of more short messages |
| [P-009](#p-009) | 2026-11-14 | David | architecture | 2 | Machine learning on the global data, on Google Cloud's free credit |
| [P-010](#p-010) | 2026-11-14 | David | architecture | 2 | Deploy on my account |
| [P-011](#p-011) | 2026-11-14 | David | process | 1 | One connection, and a job I can supervise myself |
| [P-012](#p-012) | 2026-11-14 | David | process | 2 | Keep the prompts and declare where AI was used |
| [P-013](#p-013) | 2026-11-15 | David | presentation | 2 | A global product: the copy stops naming one region |

Every entry so far was received by Devin. Lautaro's own words are added by his assistant; until then his decisions are listed [at the end](#decisions-by-lautaro-in-the-team-log).

## Day-by-day record of both authors

[`earth_satellite_system_prompt.md`](earth_satellite_system_prompt.md) holds the wider record: the key prompts of Lautaro and David from 13 to 15 November 2026, ordered by day and, inside each day, by person and time (UTC-3). Each prompt carries its theme and what it steered. The texts are cleaned and trimmed to the instruction that mattered; the ids P-001 to P-013 above are cited where they apply. The file name is kept because earlier links point to it.

### P-001

**Rank the challenges without agreeing with me** · 2026-11-13 · scope · importance 3 · David via Devin

> no coinidas conmigo, cual es el mejor o mas demandante en capacidad tecnica, dominio de las ciencias implementacion de nuevas tecnologias como ml o agentes y que ademas de eso cumpla reglas, cause impacto y demas

In English: "Do not agree with me: which one is the best, or the most demanding in technical capacity, command of the science and use of new technology such as ML or agents, and on top of that follows the rules, has impact and so on?"

- **Situation:** The night before the team started building, David was comparing challenges with his assistant and wanted a ranking that did not simply follow his own preference.
- **Decision:** The assistant compared the 2026 challenges on technical demand, room for machine learning, impact and the risk of not finishing, and recommended Harmonization of MODIS and VIIRS Hot Spots: a result that can be measured where the sensors overlap, point data instead of heavy rasters, and a use that reaches fire brigades. The choice stayed open that night; the next morning the team was working on that challenge.
- **Impact:** The challenge aeros answers, in the header of `plan.md`.
- **References:** `plan.md`.

### P-002

**Gran Chaco, Corrientes and Paraguay are the first regions** · 2026-11-14 · scope · importance 3 · David via Devin

> gran chaco, corrientes, paraguay esas seran las regiones iniciales del mvp mientras descargo el resto de los datos

In English: "Gran Chaco, Corrientes, Paraguay: those will be the first regions of the MVP while I download the rest of the data."

- **Situation:** The pipeline ran on a synthetic archive and the real FIRMS files were still downloading.
- **Decision:** Three study regions with open outlines: the Gran Chaco (RESOLVE Dry and Humid Chaco), Corrientes and Paraguay (geoBoundaries). A region is the set of H3 cells whose center is inside the outline, and one translator is fitted on the three.
- **Impact:** `aeros run --regions all` and the outputs per region.
- **References:** Pull request 1; team decision "MVP study regions: Gran Chaco, Corrientes, Paraguay".

### P-003

**We do not trim the data** · 2026-11-14 · data · importance 3 · David via Devin

> no vamos a recortar datos, para empezar a poder crear alertas tempranas necesitamos lo mas actual, pero necesitamos todos los datos para meter machine learning y aprender de lo historico.

In English: "We are not going to trim the data: to start raising early warnings we need the most recent, but we need all of it to bring in machine learning and learn from the history."

- **Situation:** The yearly archive was still downloading and the question was whether to go on with part of it.
- **Decision:** Keep the whole archive. One assistant ran the pipeline on the most recent data already on disk while another completed, compared and ordered every download.
- **Impact:** `aeros build-db`: every FIRMS download in one Parquet store by platform and year, time-sorted and deduplicated, with coverage and comparison reports.
- **References:** Pull requests 2 and 5.

### P-004

**Sell it as an early-warning agent** · 2026-11-14 · presentation · importance 3 · David via Devin

> la ui de este producto debe ser impactante [...] un texto h1 + un impactante h3 de 2 lineas que venda el producto como agente de deteccion temprana y bajo un scroll una represacion de los datos tales como se encuentran actualmente en el repo del frontend, la idea es seguir usando las barras y las celdas de panal pero superpuestos en una capa simulada de imagen satelital [...] me faltaria poder mostrar que avisa por whatsapp y mail cuando el sistema detecta que hay una alerta temprana en la region

In English: "The UI of this product must be striking [...] an h1 plus a striking two-line h3 that sells the product as an early-detection agent and, one scroll down, the data as the frontend has it today; the idea is to keep the bars and the honeycomb cells but over a layer of satellite imagery [...] what I still need is to show that it warns by WhatsApp and e-mail when the system detects an early warning in the region."

- **Situation:** The web opened on a short intro and an explorer for analysts (map, calendar, CSV), and the early warning was one view among the others.
- **Decision:** A landing page in front of the dashboard that presents aeros as an early-warning agent: a globe, the record as H3 columns on satellite imagery and a preview of the alert message.
- **Impact:** The first thing a visitor reads is what aeros does for them: fire early warning. The preview of the alert became a real sign-up with P-006.
- **References:** Pull request 24.

### P-005

**The panel floats and never covers the map** · 2026-11-14 · presentation · importance 2 · David via Devin

> lo dejaria oculto para cuando el usuario toque una zona recien ani muestre la info de esa zona solamente, que el panel no tape el mapa es decir este flotando y con un boton comodo y minimalista se salga de esa info o tocando el mapa se salga

In English: "I would keep it hidden until the user taps a zone and only then show that zone's information; the panel must not cover the map, that is, it floats, and a comfortable, minimal button or a tap on the map closes it."

- **Situation:** The terrain view showed a list of sectors and a dashboard next to the map.
- **Decision:** The view is the map alone. Tapping a zone opens a floating panel with that zone only, closed by a button, Escape or a tap on empty ground.
- **Impact:** The terrain view of the dashboard.
- **References:** Pull request 24.

### P-006

**Warn the people in the risk zone, and bring the wind in** · 2026-11-14 · scope · importance 3 · David via Devin

> faltaria resolver la logica de la optimizacion de avisos. es decir avisar a quienes corresponda que esta en zona de riesgo de incendio. y conseguir una dato de api climatica de viento para agregar una capa de viento para mejorar la probabilidad, de eso mandale la logica del backend a lautaro por el mcp y vos encargate de la ui

In English: "What is left is the logic that targets the warnings, that is, warning whoever is in the fire risk zone, and getting wind from a weather API to add a wind layer and improve the odds. Send the backend logic of that to Lautaro through the MCP and take the UI yourself."

- **Situation:** The early warning went to one fixed list and looked only at hotspot counts.
- **Decision:** Three backend tasks went to Lautaro's assistant through the team log (who a fire can reach, weather in the risk, a wind grid for the UI) while David's assistant built the wind layer and the sign-up. Lautaro chose Open-Meteo as the weather source.
- **Impact:** `wind.json` and the wind layer, the Hot-Dry-Windy fire weather, sign-up with double opt-in and the Telegram bot. Lautaro later narrowed the alert to a possible fire within 50 km.
- **References:** Team decision "HIGH PRIORITY for Lautaro: targeted alerts to people in the risk zone, and wind in the fire risk"; pull requests 19, 20, 21, 22, 24 and 25.

### P-007

**It is 26 years, not 28** · 2026-11-14 · quality · importance 1 · David via Devin

> son 26 años, no 28. y en debe decir que se juntaron los datos de MODIS y VIIRS para generar alertas tempranas que sirvan para (completa vos con lo que hay en los archivos plan)

In English: "It is 26 years, not 28. And it must say that the MODIS and VIIRS data were joined to raise early warnings that serve for (complete it yourself from the plan files)."

- **Situation:** The landing copy the assistant wrote gave the record two years too many and did not say what the harmonization is for.
- **Decision:** The record is 26 years, 2000 to 2026, and the copy states the purpose in the plan's own terms.
- **Impact:** `RECORD_YEARS = 26` and the paragraph under the record in `web/src/pages/LandingPage.tsx`.
- **References:** Pull request 24.

### P-008

**A full brief for the hero instead of more short messages** · 2026-11-14 · presentation · importance 2 · David via Devin

> prompts/earth_satellite_system_prompt.md TENES UN PROMPT PARA EJECUTAR EL MOTION UI DEL FRONT

In English: "prompts/earth_satellite_system_prompt.md: you have a prompt there to carry out the motion UI of the front end." The brief it points to was a long system prompt for the hero scene; the day-by-day record below replaced it in this folder.

- **Situation:** The globe of the landing had been corrected through many short messages (size, light, spin, the speed of the satellite) without settling.
- **Decision:** David replaced them with one brief (the role, the physical setup, the layers of the planet, the lighting and a deterministic timeline) and the assistant rebuilt the scene from it. Later prompts kept adjusting the size, the speed and the fires.
- **Impact:** The hero of the landing page.
- **References:** Pull request 33; team decision "Landing hero: photoreal Earth with real fire cells, 4K/2K maps and a HyperFrames seek contract".

### P-009

**Machine learning on the global data, on Google Cloud's free credit** · 2026-11-14 · architecture · importance 2 · David via Devin

> mi intencion es hacer machine learning con los datos globales para detectar patrones historicos y generar alertas tempranas en base a patron + lectura actual + sensor de tierra o open meteo por eso necesito los $300 usd gratuitos de gcp para esa tarea, en aws podria meter tods los datos globales y a la vez hacer machine learning en la free tier?

In English: "My intention is to do machine learning on the global data to detect historical patterns and raise early warnings from pattern + current reading + ground sensor or Open-Meteo; that is why I need the free USD 300 of GCP for that task. Could I put all the global data in AWS and also do the machine learning in its free tier?"

- **Situation:** David had decided that afternoon to take big data and machine learning to Google Cloud's Free Trial. The assistant had just argued against keeping in one cloud the data an app in another cloud reads on every request.
- **Decision:** AWS serves and Google Cloud learns. Each cloud stores only what its own compute reads, only batch artifacts cross, the trained model and its predictions land in S3, and the raw FIRMS files stay local.
- **Impact:** The cloud boundary in section 4 of `plan.md` and the global FIRMS archive downloaded for the training set. Nothing in the code depends on Google Cloud yet.
- **References:** Team decision "Google Cloud (Free Trial) for big data and ML; AWS keeps the app side"; pull request 29.

### P-010

**Deploy on my account** · 2026-11-14 · architecture · importance 2 · David via Devin

> confirmo el despliegue en mi cuenta, crea un proyecto y vamos a añadir a lautaro como colaborador mas tarde

In English: "I confirm the deploy on my account; create a project, and we will add Lautaro as a collaborator later."

- **Situation:** The stacks were written and tested but nothing was deployed: the account planned for them was not available.
- **Decision:** Deploy on David's AWS account, tagged as one project, with Lautaro joining as a collaborator. The budget stack stays out because its alert would cover the whole account.
- **Impact:** The site is live at https://d1l9qps910fke.cloudfront.net.
- **References:** Team decisions "aeros runs on David's AWS account" and "Lautaro collaborates on David's AWS account through an IAM user and the GitHub OIDC deploy role".

### P-011

**One connection, and a job I can supervise myself** · 2026-11-14 · process · importance 1 · David via Devin

> no, mantengamos en una pero en un estado que pueda supervisar yo por terminal y no dependa de vos para seguir.

In English: "No, let us keep it at one, but in a state I can supervise from the terminal myself and that does not depend on you to go on."

- **Situation:** The yearly FIRMS archive, 9 GB, was downloading as a background process the assistant had started. The assistant had measured that three connections would be about twice as fast and offered to switch.
- **Decision:** One connection, and the job handed over to a terminal session of David's own, where he watches it, stops it and resumes it with one command.
- **Impact:** How long jobs are run since then. The assistant asks before raising the load on a public service.
- **References:** Team progress log.

### P-012

**Keep the prompts and declare where AI was used** · 2026-11-14 · process · importance 2 · David via Devin

> necesito tener un tracker en el repo que guarde los prompts que fueron efectivos para llegar al producto, paralelamente en el readme contar donde se uso la ia, quiza se pueda armonizar en un diagrama mermaid bien logrado

In English: "I need a tracker in the repo that keeps the prompts that were effective in getting to the product and, alongside, the README telling where AI was used; maybe both can be brought together in one well-made mermaid diagram."

- **Situation:** The steering log of the team server was written and tested but never deployed, so nothing kept the prompts, and the submission asks for an explicit declaration of how AI was used.
- **Decision:** This file, with the fields of that log, and a section of `README.md` whose diagram ties people, prompts, assistants and checks together.
- **Impact:** `README.md` and `prompts/README.md`.
- **References:** `infra/mcp/migrations/0006_steering_prompts.sql`.

### P-013

**A global product: the copy stops naming one region** · 2026-11-15 · presentation · importance 2 · David via Devin

> me gusta la comvinacion de B y C con el tiempo de every 10 minutes del C linea 1 la idea es un producto global asi que no tiene que quedar gran chaco en ninguna parte.

In English: "I like the combination of B and C, with the 'every 10 minutes' of C's first line. The idea is a global product, so 'Gran Chaco' must not remain anywhere."

- **Situation:** The hero said aeros warns "the day an area burns past its normal", which stopped being how subscribers are warned once the alert became a possible fire seen by GOES-19 within 50 km, and the page presented aeros as a product for one region. The assistant had offered three ledes inside the same character budget.
- **Decision:** The lede joins two of them: 26 years of MODIS and VIIRS on one scale, and an agent that reads GOES-19 every 10 minutes. The product copy stops naming one region. Region and sector names that come from the data stay, and so does this record, which quotes what was said.
- **Impact:** The hero ("Fire early warning" and the new lede), the page title and description, and the labels of the dashboard. The copy does not claim coverage aeros does not have: it runs on its first study region. The texts of the bot and of the alert messages are left to their owners.
- **References:** `web/src/pages/LandingPage.tsx`; team decision "Subscriber alerts only on a possible fire within 50 km; bot guide; Resend on aer-os.health".

## Decisions by Lautaro in the team log

| Date | Decision | Where it landed |
|---|---|---|
| 2026-11-14 | NOAA-21 is in the reference chain, after Suomi NPP and NOAA-20 | Pull request 7 |
| 2026-11-14 | Open-Meteo is the weather source for wind and fire weather | Pull requests 19 and 21 |
| 2026-11-14 | Subscribers are alerted only on a possible fire within 50 km, at most once every 12 hours | Pull request 30 |
