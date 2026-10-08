# Reproduce the simulation section of the original WeChat example.
# The open 85+ group's midpoint of 90 is an explicit simulation convention.
simulate_wechat_example <- function(seed = 123L) {
  if (length(seed) != 1L || !is.finite(seed) || seed != as.integer(seed)) {
    stop("seed must be one finite integer.", call. = FALSE)
  }
  set.seed(as.integer(seed))
  years <- 1990:2019
  age_starts <- seq(0, 85, by = 5)
  age_groups <- paste0(age_starts, "-", age_starts + 4)
  age_groups[length(age_groups)] <- "85+"
  data <- expand.grid(Year = years, Age_Group = age_groups)
  age_mids <- c(seq(2.5, 82.5, by = 5), 90)
  data$Age_Mid <- rep(age_mids, each = length(years))
  data$Pop <- round(runif(nrow(data), 10000, 50000) *
                      (1 + (data$Age_Mid / 100)^2))
  true_rate <- function(age, year) {
    time_idx <- year - 1990
    base_risk <- -12 + 0.12 * age
    time_trend <- -0.02 * time_idx
    interaction <- 0.0005 * age * time_idx
    noise <- rnorm(length(age), 0, 0.05)
    young_rebound <- ifelse(age < 50 & year > 2010,
                            0.05 * (year - 2010), 0)
    exp(base_risk + time_trend - interaction + young_rebound + noise)
  }
  data$Rate_True <- true_rate(data$Age_Mid, data$Year)
  data$Deaths <- rpois(nrow(data), data$Pop * data$Rate_True)
  data$Mortality_Rate <- data$Deaths / data$Pop * 100000
  data
}

