# BLSD Tool

**BLSD Tool** is the web interface for **BLSD (Bayesian Lexis Surface Dynamics)**, a model for estimating and examining smooth age–period rate surfaces. It combines a React interface, interactive ECharts graphics, and an R backend using `mgcv`. The interface is available in English and Chinese.

This directory contains the application's source code, published under `web/` in the [Aprilxxi/BLSD repository](https://github.com/Aprilxxi/BLSD).

**Public web URL:** to be added.

## Requirements

- Node.js **22.12.0 or later**.
- Corepack and **pnpm 11.25.0**, as specified in `package.json`.
- R with `mgcv`, `jsonlite`, `ggplot2`, and `scales`.
- R graphics support for the export formats you use. PDF and TIFF exports require the corresponding graphics capabilities; Chinese figure labels also require suitable fonts on the server.

Install the R packages in an R session:

```r
install.packages(c("mgcv", "jsonlite", "ggplot2", "scales"),
                 repos = "https://cloud.r-project.org")
```

The backend uses the `Rscript` executable on `PATH`. Set the **`BLSD_RSCRIPT`** environment variable to the executable's location if a particular R installation should be used. The server also checks common R installation locations on Windows.

## Run locally

From the repository root:

```sh
cd web
corepack pnpm install --frozen-lockfile
corepack pnpm dev --host 127.0.0.1 --port 4175
```

Open <http://127.0.0.1:4175>. The development server includes the analysis API and invokes R for model fitting. Load the fixed example or provide a CSV, choose the analysis settings, and select **Run analysis**.

To build and run the production application:

```sh
corepack pnpm build
node deployment/check-environment.mjs
corepack pnpm start
```

The production server listens on <http://127.0.0.1:4174> by default. Set `PORT` to change its port. `corepack pnpm start` runs `node server/index.mjs`.

The environment check should be run after the build. The test suite can be invoked with `corepack pnpm test`; R-dependent integration checks require a working R installation.

## Input data

Upload, drag and drop, or paste a UTF-8 CSV with these columns:

| Column | Meaning |
| --- | --- |
| `Year` | Numeric calendar year or period coordinate. |
| `Age_Group` | Closed integer age interval, such as `30-34` or `30-34 years`. |
| `Count` | Nonnegative event count; fractional estimates are accepted. |
| `Pop` | Positive population or exposure denominator corresponding to the count. |
| `Sex` | Optional, nonempty group label; groups are fitted separately. |

Column order may vary. Each group–age–period combination must be unique. Age groups must be nonoverlapping closed intervals. The age coordinate for `30-34`, for example, is 32.5, calculated as `(lower + upper + 1) / 2`. Each fitted group needs at least five distinct age coordinates and five distinct period coordinates, with enough observations for the chosen basis dimensions. The upload limit is 5 MiB.

### Fixed example and random seeds

The bundled [example CSV](data/example/example_data.csv) contains 442 synthetic observations: 13 five-year age groups, from 30–34 through 90–94, observed in 1990–2023. It was generated once with **data-generation seed `20261022`** and is loaded unchanged. Its generating specification is recorded in [the fixed data-generating configuration](data/example/dgp_fixed_before_sampling.json).

The separate **coefficient-draw seed defaults to `123`** and can be changed in the advanced analysis settings. Changing this setting changes the simulated coefficient draws used for uncertainty summaries; it does not regenerate the example observations.

## Model and interface defaults

The model uses a log link, a tensor product of natural cubic regression splines over year and age, and a log-exposure offset:

```r
Count ~ te(Year, Age_Mid, bs = c("cr", "cr")) + offset(log(Pop))
```

The **web interface defaults** are:

| Setting | Default |
| --- | --- |
| Family and smoothing selection | Negative binomial with REML |
| Marginal basis dimensions | 10 for age and 10 for year, reduced when required by the available coordinates |
| Joint coefficient draws | 1,000 |
| Coefficient-draw seed | 123 |
| Age-gradient threshold for equivalent age movement | 0.005 |

Quasi-Poisson with REML and quasi-Poisson with GCV are also available. Uncertainty summaries use approximate Bayesian coefficient draws. The displayed 95% uncertainty intervals are pointwise fitted-model intervals. Rates are displayed per 100,000 denominator units.

## Results and downloads

Each successful group fit provides eight views:

1. Fitted rate or log-rate surface.
2. Local annual percentage change.
3. Temporal log-rate curvature, shown in the acceleration view.
4. Age profiles at selected periods.
5. Age-specific temporal trends.
6. Age gradient.
7. Equivalent age movement.
8. Deviance residuals.

The downloads include a **figure archive** covering all eight views for each successful group, a **table archive** with a workbook for each group, and a **complete analysis archive**. Figures can be exported as vector PDF or 600 dpi PNG/TIFF. Tables contain inputs, estimates, uncertainty summaries, and diagnostics. The complete archive also includes standardized input data, full result JSON, saved R models, coefficient draws, and analysis settings. These exports use the retained fit and draws, without refitting the model.

## Deployment and data retention

Analysis requires the Node/R service. For a Linux deployment, see the [Linux deployment guide](deployment/DEPLOYMENT_LINUX_zh.txt) (Chinese) and the configuration examples in [`deployment/`](deployment/). These cover the runtime checks, service setup, reverse proxy, and HTTPS configuration.

After installing dependencies and building the application, a runtime-only Linux archive can be generated with Python 3.9 or later:

```sh
python scripts/package-release.py --linux
```

The command reports the archive location under `../output/deployment/`. Use that generated archive and checksum in place of the dated example filenames in the deployment guide. Each new archive includes the project MIT license and third-party notices.

The default service retains the **five most recent analysis runs**, with a **one-hour lifetime** measured from completion. A run containing several sex groups counts as one analysis. Inputs and generated artifacts are held temporarily in the server job directory; expiration and normal shutdown clean up the application's retained files. Restarting the service invalidates retained results, so download the required archives while they are available.

Configure server logs, reverse-proxy logs, backups, and their retention policies as part of deployment. Application cleanup does not manage separately maintained logs or backups. The current service has no built-in accounts or per-user result isolation; deployment access controls should match the intended audience.

## License

The original BLSD Tool web application code and accompanying software documentation are released under the [MIT License](../LICENSE). Copyright © 2026 Ruhai Bai and Jinchao Hua.

Third-party dependencies, fonts, and any externally supplied datasets retain their respective licenses and terms. Consult the license files of the installed packages and the third-party notices supplied with release bundles.
