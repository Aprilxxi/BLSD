# BLSD: Bayesian Lexis Surface Dynamics

English | [简体中文](README.zh-CN.md)

**BLSD (Bayesian Lexis Surface Dynamics)** is the statistical model; Lexis refers to the age–period coordinate structure. **BLSD Tool** is the web application for running the model and exploring its results.

## Web application

The web application source is in [web/](web/README.md), including the React interface, Node.js/R backend, model and export code, tests, and deployment scripts.

- [Installation and usage](web/README.md)
- [Example CSV](web/data/example/example_data.csv) and [fixed simulation specification](web/data/example/dgp_fixed_before_sampling.json)
- [Linux deployment guide](web/deployment/DEPLOYMENT_LINUX_zh.txt) (Chinese)
- Public web URL: to be added.

The fixed example contains 442 independently simulated observations: 1990–2023 and 13 closed five-year age groups from 30–34 to 90–94. Its data-generation seed is **20261022**. The web interface's coefficient-sampling seed is user-configurable (default **123**); changing it does not regenerate the example counts.

Web outputs include eight interactive figures, approximate 95% pointwise model uncertainty intervals, diagnostics, downloadable figures, result tables, and complete analysis archives. See the [web application documentation](web/README.md) for input requirements, server-side processing, and temporary data retention.

## Standalone R scripts

Two standalone R scripts are also available:

| Script | Purpose |
| --- | --- |
| [BLSD_Analysis_Selectable.R](BLSD_Analysis_Selectable.R) | Fit the selected model to counts and matching denominators, and produce seven figures. |
| [BLSD_Plot_Web_Download.R](BLSD_Plot_Web_Download.R) | Redraw seven figures from downloaded web results while preserving estimates, intervals, and masks. |

### Analyze data

Install the required R packages:

```r
install.packages(c("mgcv", "ggplot2", "gridExtra"))
```

Open `BLSD_Analysis_Selectable.R` in RStudio, edit `blsd_config` near the top of the script, and select **Source**. Alternatively, run this command from the script's directory:

```r
source("BLSD_Analysis_Selectable.R", encoding = "UTF-8")
```

The script embeds the same fixed 442-observation example used by the web application and loads it without resampling. Defaults are negative binomial with REML, 1,000 coefficient draws, coefficient-draw seed 123, and marginal basis dimensions of 10 for age and period.

Select the fitting method with these two settings:

| `distribution` | `smoothing` | Fitting method |
| --- | --- | --- |
| `"quasipoisson"` | `"GCV"` | Quasi-Poisson with GCV |
| `"quasipoisson"` | `"REML"` | Quasi-Poisson with REML |
| `"nb"` | `"REML"` | Negative binomial with REML; θ is estimated during fitting |

Negative binomial with GCV is rejected because the relevant `mgcv` calls use REML or UBRE. The script checks the method actually used to keep labels consistent with the fit.

### Use your own CSV

Replace `input_csv = NULL` with a file path, for example `input_csv = "my_data.csv"`.

| Column | Content |
| --- | --- |
| `Year` | Period coordinate. |
| `Age_Group` or `Age_Mid` | Closed age interval or numeric age midpoint; `30-34` corresponds to [30, 35), with midpoint 32.5. |
| `Count` or `Deaths` | Nonnegative event count; fractional values are retained. |
| `Pop` | Positive population or exposure denominator. |
| `Sex` (optional) | Group label; each group is fitted independently. |

For open-ended age groups, first determine a justified numeric age coordinate and supply it through `Age_Mid`. Multiple `Sex` groups are analyzed separately by default; use `selected_sexes` to select particular groups. Period–age combinations must be unique within each group.

### Figures and saved results

The standalone scripts produce seven figures: the fitted surface, annual change, temporal log-rate curvature, fitted-rate versus deviance-residual diagnostics, age profiles, age-specific temporal trends, and a paired panel of age gradient and equivalent age movement.

Figures appear in RStudio's **Plots** pane by default. Setting `output_dir = "BLSD_figures"` also saves seven PDF and 600 dpi PNG figures for each group. Set `formats` to `"pdf"`, `"png"`, or both. `blsd_result` retains models, coefficient draws, numerical tables, diagnostics, and plotting objects. Residual plots use fitted rates per 100,000 on a logarithmic horizontal axis, with points colored by age, as in manuscript Figure 3D.

Each group also receives an `mgcv::k.check` basis-dimension check, including the maximum basis degrees of freedom, EDF, k-index, and permutation P value. Results are stored in `blsd_result$groups[[1]]$diagnostics$basis_checks`. The check uses a separate seed of 20261015, 400 permutations, and at most 5,000 observations, then restores the random-number state so the coefficient draws remain unchanged. Unavailable diagnostics retain their status and reason.

## Redraw downloaded web results

Install the plotting and file-reading dependencies:

```r
install.packages(c("ggplot2", "gridExtra", "jsonlite", "readxl"))
```

After downloading web results, open `BLSD_Plot_Web_Download.R`, set `input_path` near the top to the downloaded file, and select **Source**. Leaving it empty in an interactive RStudio session opens a file chooser.

Supported inputs are:

- **Complete analysis archive ZIP**: recommended; includes numerical results, fitted rates at observed coordinates, original contour vertices, and model diagnostics.
- **Result-table ZIP** or a single **XLSX**: supports the current English and Chinese worksheets. Excel does not store original contour vertices, so contour lines are omitted when redrawing. Residual plots use the fitted rates and deviance residuals stored in the worksheets.
- A single `results.json` or an extracted archive directory.

For archives containing multiple groups, the script produces seven figures per group. It uses the downloaded estimates, intervals, and masks without refitting or resampling. `section_years` and `trend_ages` select coordinates already present in the downloaded grid; `output_dir` and `formats` control PDF/PNG output.

Formulas, the simulation mechanism, interval calculations, stability screening, and diagnostic rules are described in the [methods documentation](docs/methods.md). Its methodological references retain the numbering and bibliographic details of the JSHR submission dated October 25, 2026; software manual links are listed separately.

## License

The BLSD Tool web application and its accompanying software documentation are licensed under the [MIT License](LICENSE), Copyright © 2026 Ruhai Bai and Jinchao Hua. Third-party components, fonts, and external data retain their respective licenses and terms.
