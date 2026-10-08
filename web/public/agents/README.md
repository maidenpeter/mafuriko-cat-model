# Saved agent runs that ship with the app

The files here let the Agents step show a full run, and the "Assumptions" switch work, with no API key and no network.

## What is here

- `index.json` lists the runs. Each line holds the file name, the kind (`portfolio` for a run made with no offer loaded, `offer` for one made on a priced offer), when the agents ran, the model that answered, and what the run was made on: the data set's name, its building count, its total insured value and the fingerprint of the reference result. An offer run also holds the key of the offer the agents saw.
- `portfolio-<date>.json` and `offer-<date>-<key>.json` are the runs themselves, in the form the app saves any run: what the run was made on, the model, the tokens used, each agent's reply and the final parameters.

No loss figure is stored. When the app replays a run, code works out every figure again from the saved replies and runs the usual checks.

## When the app uses a run

On load, if this browser holds no run of its own, the app reads `index.json` and replays the run made on the same data and the same model. It is labelled "Saved run from <date>, model <name>". A live run, or a run loaded from a file, takes over.

- With a priced offer on screen, the offer run with that offer's key is used. With any other offer the portfolio run applies and the offer's assumptions beyond flood depth stay on their reference values.
- A run made on other data, or before the model changed, is not replayed. The Agents step says so in one line.
- With an empty list (`{ "runs": [] }`) the app behaves as it does with no saved run.

## How the files are made

1. Run the app with an API key, load the model data, and run the agents once (with no offer loaded for a portfolio run, with the priced offer loaded for an offer run).
2. Take the run out of the browser, either way:
   - the value under the storage key `mafuriko:run:<data set>:<buildings>:<total insured value>` (in the browser's developer tools, under local storage), saved to a file;
   - or the file from "Save the agent run for replay" on the Audit step.
3. From `web`, pack it:

```
node scripts/pack-run.mjs <saved-run.json> --kind portfolio
node scripts/pack-run.mjs <saved-run.json> --kind offer --drop-prompts
```

The script checks that all four agents replied and that the final parameters and the inputs are there, writes the run here under a dated name and lists it in `index.json`. A newer run replaces an older one of the same kind made on the same data (and, for an offer run, on the same offer).

`--drop-prompts` leaves out the text of the prompts sent and the sentences of the offer document held in the saved brief. Use it for a run made on a real offer. The replies are kept as they are, so read them before the file is shared.

Do not edit the run files by hand: a replay is checked against the fingerprint saved in the run.
