# VEXA

AI agent dashboard + live cloud phone.

- Dashboard — https://joshbond123.github.io/VEXA/
- Phone — https://joshbond123.github.io/VEXA/phone/

## What it is

* **Dashboard** – submit a plain-language task; the agent turns it into real input events
  (tap, swipe, type, key) on the connected Android device, and the run is logged live.
* **Automations** – task + interval (30 m / 1 h / 2 h / 3 h / custom) plus an
  independent *AI-decided* schedule where the model judges whether more work is needed
  and picks its own next run time.
* **AI Models** – xAI Grok, NVIDIA Nemotron, OpenAI or any OpenAI-compatible endpoint.
  Keys are stored only in your browser (`localStorage: vexa.keys`) and are never
  committed, bundled or logged. Nothing secret exists in this repository.
* **VEXA Phone** – the live Android device (WebCodecs H.264 stream from the VEXA phone
  backend). Real touch, typing, scrolling and navigation, shared between you and the agent.
  If the device is unreachable the UI says so and keeps retrying — it never shows a
  fake picture.

## Deploy

Every push to `vexa` (or `main`) builds and publishes the site with GitHub Actions.
The original VIBELY Android work lives in its own repository and is not touched here.
