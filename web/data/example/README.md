# Independent simulated example

[example_data.csv](example_data.csv) contains the fixed input used by the BLSD Tool example: 442 observations, periods 1990-2023, and 13 closed five-year age groups from 30-34 to 90-94. Columns are Year, Age_Group, Count and Pop. These counts do not represent observations from a real population.

The data-generation seed is 20261022. The negative-binomial generating size is 300. The complete generating formulas, coordinate definitions, row order and parameters are recorded in [dgp_fixed_before_sampling.json](dgp_fixed_before_sampling.json). The fitted negative-binomial size is estimated from the data and is distinct from the generating value.

The web interface loads the stored observations without resampling. The coefficient-draw seed is separately configurable, with default 123. All fitted quantities are computed by the R backend after Run analysis.

`scripts/prepare-example-module.mjs` checks the CSV and generating-specification hashes before preparing the embedded example and public download. Run it from the web directory with `node scripts/prepare-example-module.mjs`. It copies the fixed data and does not generate new observations or fit a model.

The `sourceGenerationScript` fields in retained provenance metadata record the relative location of the original research script in the development archive. They are historical provenance labels, not runtime dependencies or links within this repository. The fixed CSV and its full generating specification are included here.

CSV SHA-256: 5d2b2edac8329cedf6b2fecb29fbb046b62b892dfba27255c9d4541575a0f46c.
