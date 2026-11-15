# Team prompt record, day by day

Key prompts from Lautaro and David during the NASA Space Apps Challenge 2026 (13 to 15 November), ordered by day and, within each day, by person and time. Each prompt carries its time, its theme and what it steered in the product.

- **Time zone:** UTC-3 for both people.
- **Sources:** Lautaro's sessions with Claude, and David's prompts kept in Engram and in the entries P-001 to P-013 of [`README.md`](README.md), which are cited by id.
- **How the texts were edited:** they are cleaned and trimmed to the instruction that mattered, with spelling fixed. They keep the intent, the constraints and the decision of the originals; nothing was added that was not asked for. The originals are in each person's own log. The use of AI is declared in the submission.
- **Left out:** phone numbers, e-mail addresses and keys.

Themes: `CONTEXT` how the team coordinates and works · `SCOPE` what the product is · `DATA` · `ARCHITECTURE` · `DEVELOPMENT` · `DESIGN` interface and animation · `ALERTS` e-mail, SMS and Telegram · `VALIDATION` · `PRESENTATION`.

| Day | Lautaro | David |
|---|---|---|
| 2026-11-13 | 0 | 1 |
| 2026-11-14 | 14 | 29 |
| 2026-11-15 | 12 | 6 |
| Total | 26 | 36 |

Each entry can group several consecutive messages on the same topic. What they have in common: each person decides the what and the why, sets an explicit constraint (cost, scope, language) and verifies before accepting. The AI does the how.

---

## Day 1 · Friday 2026-11-13

### David

**Evening · `SCOPE` · P-001 (importance 3)**
"Do not agree with me: which challenge is the best, or the most demanding in technical capacity, command of the science and use of new technology such as ML or agents, and that also follows the rules and has impact?"
→ **Steered:** each challenge was compared on technical demand, room for ML, impact and the risk of not finishing. *Harmonization of MODIS and VIIRS Hot Spots* was chosen because the result can be measured where the sensors overlap and it serves fire brigades.

---

## Day 2 · Saturday 2026-11-14

### David

**10:29 · `CONTEXT` · Start**
"Understand this project and let us start interpreting and executing the plan."

**11:20 · `ARCHITECTURE` · Logic base on the AWS free tier**
"Let us start by building the logic base. The infrastructure is designed to live on the AWS free tier: use the AWS Agent Toolkit."
→ **Steered:** all infrastructure was designed inside the free plan.

**11:55 · `CONTEXT` · Less verbose**
"Be less verbose and more concise. Fix what you found and move on to the next thing. Lautaro is fixing the Cloudflare MCP so the agents can coordinate."

**12:12 · `DATA` · Own FIRMS downloads**
"See what you can get on your own from FIRMS (active fire); I am also downloading by hand, but start." Then: "Could we create a real-time script that downloads every new file the system generates?"

**13:08 · `CONTEXT` · Coordination between agents**
"Before developing, use the MCP to talk to the other agent and pull the repo changes without losing what is local." Later: "The plan in the repo is new: ask the other agent through the MCP what it is working on and take a different task."
→ **Steered:** the assistants split the work without stepping on each other.

**13:25 · `SCOPE` · First regions · P-002 (importance 3)**
"Gran Chaco, Corrientes and Paraguay will be the first regions of the MVP while I download the rest of the data."
→ **Steered:** three study regions with open outlines, and one translator fitted on the three.

**13:53 · `CONTEXT` · Each task closes with its own commit and push**
"Let us work along that line: each task closes with its own commit and is pushed before the next one, so the other agent can go on with something else."

**14:13 · `DATA` · Do not trim the data · P-003 (importance 3)**
"We are not going to trim the data. To raise early warnings we need the most recent, but we need all of the history for machine learning. Run the pipeline on the latest data already here, and let the other agent complete, compare and download what is missing."
→ **Steered:** a Parquet store with every FIRMS download, ordered by satellite and by time, with no duplicates.

**14:21 · `DATA` · Split of tasks**
"The other agent develops the backend with the most recent data; you complete, compare and order the missing data by satellite, by time and by whatever parameter helps, so we have a base ready for ML."

**16:11 · `ARCHITECTURE` · Google Cloud for big data and ML**
"I have this free-trial offer: we will use GCP for big data and machine learning. Leave the decision in the MCP so Lautaro knows and understands it."

**16:55 · `DESIGN` · Interface plan**
"I left a `frontendplan.md` in the folder: run it."

**17:06 · `DESIGN` · The panel floats and does not cover the map · P-005 (importance 2)**
"I would keep the information hidden until the user taps a zone, and then show only that zone's. The panel must not cover the map: floating, closed with a comfortable, minimal button or by tapping the map."
→ **Steered:** the terrain view is the map alone, with one panel per zone.

**17:12 · `DESIGN` · Zoom made for the citizen**
"A zoom that gets closer to the zone: the ordinary citizen or the government office must be able to see their own city affected." And: "The dashboard should let you go back to the presentation."

**17:55 · `ALERTS` · Warn the right people and add wind · P-006 (importance 3)**
"What is left is the logic that targets the warnings: warn whoever is in a fire risk zone. And get wind from a weather API to improve the probability. Send the backend logic to Lautaro through the MCP and take the interface yourself."
→ **Steered:** three backend tasks for Lautaro (who a fire can reach, weather in the risk, a wind grid) and the wind layer and sign-up in David's interface. The weather source was chosen by Lautaro: Open-Meteo.

**17:57 · `DESIGN` · Wind layer**
"Imitate Windy's wind layer (reverse-engineer it) and check whether the other NASA Space Apps challenges have wind datasets we can cross. Build the interface layer and hand Lautaro the tasks at high priority." Then the visual criterion: "No background color; intensity reads two ways: light wind, a fainter line and slow movement; strong wind, more intense and faster lines; more minimalism and fewer layers, and make it one more layer, not a button."

**18:06 · `VALIDATION` · It is 26 years, not 28 · P-007 (importance 1)**
"It is 26 years, not 28. And it must say that the MODIS and VIIRS data were joined to raise early warnings."
→ **Steered:** the record reads 26 years (2000 to 2026) and the text states what the harmonization is for.

**18:29 · `DESIGN` · Physical-political map**
"Instead of a grey map, a physical-political layer: blue sea and colored land, not white."

**18:49 · `DESIGN` · High-end motion UI**
"Use the HyperFrames skills to understand motion UI and make the Earth animation, and the rest of the canvas, in the best quality."

**20:43 · `DESIGN` · A full brief for the hero · P-008 (importance 2)**
"There is a prompt in the prompts folder to carry out the motion UI of the frontend."
→ **Steered:** many short messages were replaced by one brief (role, physics, planet layers, lighting and a deterministic timeline) and the scene was rebuilt from it.

**20:50 · `DEVELOPMENT` · Closing the pending items**
"Move on all of these pending items": NOAA-21 history (only 7 days of NRT so far), the AWS deployment, the daily fire-weather chip in the dashboard, the mandatory credits to Open-Meteo (CC BY 4.0) and GOES-19, and a rebase of the local work onto develop.

**20:57 · `ARCHITECTURE` · ML on Google Cloud, application on AWS · P-009 (importance 2)**
"My intention is to do machine learning on the global data to detect historical patterns and raise early warnings from pattern + current reading + ground sensor or Open-Meteo. That is why I need the free USD 300 of GCP. Could I put all the global data in AWS and also do the machine learning in its free tier?" Then: "Do it in agentic format and in Mermaid. I approve GCP as a gym."
→ **Steered:** AWS serves and Google Cloud learns; only batch artifacts cross, and the model and its predictions land in S3. Today the code does not depend on GCP (ML was set aside later).

**21:42 · `ARCHITECTURE` · Deploy on my account · P-010 (importance 2)**
"I confirm the deploy on my account: create a project, and we will add Lautaro as a collaborator later." The ML result will live in S3, looking after the free plan. "For the slides and the pitch we will use the Corrientes fire and the one on the United States coast: both share an operation that fails in a poor province and in a first-world state."
→ **Steered:** the site went live on CloudFront, and the contrast between Corrientes and Los Angeles became the central argument of the presentation.

**21:49 · `DATA` · Shared downloads**
"How do we multiply the downloads of the yearly files between this team, another team of mine and Lautaro, and then put everything together?"

**22:06 · `CONTEXT` · One connection I can supervise · P-011 (importance 1)**
"No: let us keep a single connection, in a state I can supervise from the terminal myself and that does not depend on you to go on."

**22:26 · `DESIGN` · A terrain map for the ordinary user (importance 3)**
"1. The wind layer does not move: it is frozen lines that do not scale with the zoom. 2. I understand the color scale (purple low, yellow-white high), but for the ordinary user high risk is always red and low risk goes to blue-violet; make the cells translucent so city names can be read, and name them with nearby places (for example "General San Martín, Chaco") instead of the dataset's region name. 3. The panel of a cell is not understandable for whoever receives the alert on a phone or for the office that checks the false positive. 4. If the user is not somewhere with a possible alert, I would show nothing, or show in a side ticker the fires detected elsewhere in the world."
→ **Steered:** a color scale with red for high risk, plain language in the panel and an alert that depends on the reader's place.

**22:30 · `CONTEXT` · Pitch and demo**
"Keep the pitch and demo in Engram, we are not working on that now. Add records to the map so the demo fits the pitch."

**22:47 · `ARCHITECTURE` · Lautaro as collaborator**
"Let us add Lautaro as a collaborator on the project so he can do CI/CD and whatever changes he needs; he has the AWS Agent Toolkit."
→ **Steered:** an IAM user for Lautaro and a deploy role for GitHub Actions, with no stored keys.

**23:04 · `CONTEXT` · Prompt tracker and AI declaration · P-012 (importance 2)**
"I need a tracker in the repo that keeps the prompts that were effective in getting to the product and, alongside, the README telling where AI was used; maybe both can be brought together in one well-made Mermaid diagram." Also: "The product name has to be short and make the user's mind say: early warning. The h3 must have marketing and technicality at once, within the character budget."
→ **Steered:** `prompts/README.md` and the README section with the diagram.

**23:07 · `DESIGN` · Pace of the globe**
"The spin must be half as fast and the satellite slow down in the same ratio; the planet, 30 % bigger." Then: "Let us slow everything down a bit more. I would remove the satellite's trajectory, put fires over Australia and add two satellites, MODIS and VIIRS, orbiting the way they do in reality."

### Lautaro

**14:20 · `CONTEXT` · Shared memory between the two assistants**
"Collect the prompts that keep steering us in the product, to build a study of the most important situations and of the decisions we took from each one. I want the MCP to work like that and to keep the most important of what we both prompt."
→ **Steered:** the team MCP became the shared memory of Claude (Lautaro) and Devin (David).

**15:13 · `CONTEXT` · Orderly integration**
"David pushed and the pull requests are open: merge them in an orderly way."
→ **Steered:** the stacking order was respected (#1 before #5), as was the rebase of the pull requests that touched the same table of the plan.

**15:31 · `CONTEXT` · Two parallel lines**
"Let us get everything ready so David works on the interface on a separate branch. We (Lautaro and my LLM) work on the logic of the program."

**18:32 · `DEVELOPMENT` · Earlier detection with GOES**
"Read the repo changes, we apply changes to the logic and add GOES to detect fires earlier."
→ **Steered:** a fast detection layer on GOES-19 every 10 minutes that warns through the same channels as the daily alert. It only counts what GOES itself marks as certain, inside the study cells, seen in at least 2 of 3 scans and announced once every 12 hours.

**18:49 · `DEVELOPMENT` · Wind from Open-Meteo**
"Can we use this Meteomatics API for the wind?" → "Fine, let us use Open-Meteo."
→ **Steered:** a free, open source instead of a commercial alert service.

**19:18 · `ARCHITECTURE` · Everything on the AWS free tier**
"The infrastructure has to go on AWS, with the Cloudflare tunnel as we planned. With the AWS Toolkit, check what we can use in the free tier; I have a new account and can redeem the USD 100 so the infrastructure is more robust and we also stand out for that."

**20:03 · `ALERTS` · What is missing for a real warning**
"The notifier, the subscription API and the Telegram bot are missing: nobody can receive a real warning. This is what we need to implement."

**20:09 · `ARCHITECTURE` · Plan B for the AWS account**
"Let us get everything ready to deploy on AWS with David's account, and record that everything deployed fits the free tier."
→ **Steered:** Lautaro's own AWS account was not available, so the deploy went out on David's and Lautaro was added as a collaborator afterwards.

**21:06 · `ALERTS` · E-mail independent of the AWS account**
"What other method is there so I can take care of the e-mail? David handles the compute on GCP for the ML, the interface and the AWS deployment." → "Let us do this: Resend."
→ **Steered:** Resend (3,000 e-mails a month free, no sandbox) instead of SES, with the keys in environment variables and not in the repo.

**21:22 · `ALERTS` · Warnings anyone can understand**
"Telegram has to be in Spanish according to my region. Alerts have to be readable for all citizens, most of whom are not technical." "The same rule applies to e-mail."

**21:43 · `ALERTS` · The location comes from the town**
"I do not want to send my location to the bot so it warns me. I want it to warn me automatically according to my location; if that is not possible, the user enters which town they want warnings for, and that is it."
→ **Steered:** a subscription by chosen town, with no data from the device.

**22:07 · `ALERTS` · Fewer, more relevant warnings**
"Once a week seems like a lot: can it not warn only when a possible fire is detected? On the panel we show 25 km cells and you say 100 km around: let us bring it down to 50 km so it can be tied to a neighboring plot."
→ **Steered:** the warning fires on an event, with a radius consistent with the grid.

**22:10 · `VALIDATION` · More data crossings**
"How do we integrate these NASA datasets to add another crossing with the ones we already have, so the system predicts with more certainty? Did you take into account that we already use GOES and the others?" Later: "If that API is better, let us integrate it. Test it and tell me which option suits our case better."
→ **Steered:** NASA POWER was added as a climate factor, chosen by a test.

**22:45 · `ARCHITECTURE` · Own domain**
"We already have the site served on CloudFront. I need to put it through Cloudflare and leave the domain at aer-os.health, which we got from Porkbun."

---

## Day 3 · Sunday 2026-11-15 (submission closes at 23:59)

### David

**00:11 · `CONTEXT` · Smaller tasks**
"If it is still too much, split the tasks by number as I passed you in the prompt." And at 01:12: "This is the second time you ask me for this validation: cut the tasks into smaller portions that Gentle cannot cut."
→ **Steered:** each commit stays under 300 lines and passes the automatic review without asking for another.

**00:19 · `DATA` · Base for the ML**
"How are the downloads going, to prepare the ML base on GCP? I have downloads running in the background."

**01:00 · `PRESENTATION` · A global product · P-013 (importance 2)**
"I like the combination of B and C, with the 'every 10 minutes' of C's first line. The idea is a global product, so 'Gran Chaco' must not remain anywhere. When that is done, leave nothing unpushed to the PR."
→ **Steered:** the landing announces "Fire early warning": 26 years of MODIS and VIIRS on one scale and an agent that reads GOES-19 every 10 minutes. Region names that come from the data stay.

**01:03 · `CONTEXT` · Bring in Lautaro's work**
"When you finish, let us pull the rest of Lautaro's development."

**01:22 · `CONTEXT` · Delegate so the session is not lost**
"You have the Antigravity session in the folder: pass it a prompt and see if you can delegate tasks; I want to avoid running out of quota and being unable even to save to Engram." Then: "Pause everything, save everything in Engram; tomorrow with a new quota I continue."
→ **Steered:** a hand-off prompt was left to continue the terrain interface work with any other agent, with the repo's rules.

**01:29 · `PRESENTATION` · Name**
"I like 'fire early warning'. Save everything; in the morning we continue."

### Lautaro

**00:52 · `ALERTS` · Report a fire, audit and night work**
"A feature to report fires is missing: the user enters the location where there is one and the system is asked to verify it, through Telegram or through the page. Also audit the code. Keep iterating so everything is polished when we start tomorrow. The site is deployed but we have not yet got the AWS CNAME to host the domain properly: tomorrow we do that."

**09:29 · `VALIDATION` · How do we know the percentage is right?**
"How do we validate the data? How do we know they work so that it gives the right probability percentage? What happens when there is no internet connection?"
→ **Steered:** the quality of the calculation was measured (backtest) and the offline behavior was thought through.

**09:58 · `VALIDATION` · No machine learning, and saying so**
"We are not going to do machine learning: we set it aside because we did not get to integrate GCP. I need to validate the real data used today in the logic to expose what the Python backend does."
→ **Steered:** the scope stayed at a rule-based system over real data.

**10:09 · `VALIDATION` · Honesty about the "prediction"**
"We sell Aeros as an early fire warning, but there is no LLM that predicts: how is that 'prediction' made?"
→ **Steered:** the presentation explains openly how a warning is reached.

**10:33 · `PRESENTATION` · Two fires to contrast**
"We want to add videos of two events. Corrientes 2022 (no resources): no planes or heavy infrastructure, 12 % of the province burned and they depended on a neighborhood collection. Los Angeles 2025 (infinite resources): helicopters and retardant within minutes, and the houses in Pacific Palisades burned all the same. The problem is physics and time, not money."

**10:40 · `PRESENTATION` · Art direction**
"The videos have to be editorial style, with wide images, so we can add the text by hand on top." Then: "It has to look like a recording of the fire, not a satellite image; it must hurt and have impact." "Let us show something local, from the north."

**11:44 · `PRESENTATION` · Impact figures**
"How was the 2022 Corrientes fire discovered? To compare in the slides we need how much was lost and how much would have been saved had the system detected it almost 30 days earlier."

**12:32 · `PRESENTATION` · Editing the main video**
"1 to 6 does not work: keep 7, 8 and 9, no added speed, they should look smooth. David passed me the slides through the MCP: finish shaping them." "We need a video with impact, one that hurts in the first seconds and proposes the solution simply: the audience does not understand technical terms." Then: "I do not like those wave effects; no motion blur, just make it look good and in quality." "The background from second 9 to 25 looks generic: it has to change."

**12:34 · `PRESENTATION` · Questions from the jury**
"I am sending you some photos, do not answer yet." → "Answer them based on our project."

**13:54 · `PRESENTATION` · Demo of the citizen's warning**
"Make me a video of the Telegram bot and of the notification the user receives by SMS, consistent with the presentation video. The user replies nothing: show that they subscribed on a date and later receive the warning automatically. First the SMS, then Telegram: that is the order of priority." "Give me the English version too."
→ **Steered:** SMS is the main channel and Telegram the second.

**14:37 · `CONTEXT` · Release**
"We made changes in the repo: let us merge the content of develop into main and check the state of the API at aer-os.health."

**16:01 · `ALERTS` · One-step SMS**
"There must be no confirmation reply. It has to send the message 'You are subscribed successfully' and tell them what they will receive, because the user already entered their number on the web." "If the user does not enter their town on the web, the area code's town is loaded." "Apply those changes completely in the backend and the frontend; try it with David's number."
→ **Steered:** sign-up by SMS became a single step and the town comes from the area code.

---

## Notes

- Phone numbers, e-mail addresses and keys were left out.
- The long instructions among David's prompts (the globe brief, the hand-off to another agent, the data staging for transfer over SSH) are summarized here; the full text is in his Engram log.
- The `steering_prompts` table of the team MCP is not deployed, so no prompts are stored there.
- The "Steered" lines are a synthesis from the prompts and from the entries in the repo; both authors should review them.
