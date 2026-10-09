# ============================================================
# BLSD-S
# 在RStudio运行整段代码或 source("BLSD_Model_Analysis.R")。
# ============================================================

# 0. 环境准备（修改 M01：只保留实际使用的三个包）
# 首次使用：install.packages(c("mgcv", "ggplot2", "gridExtra"))
library(mgcv)
library(ggplot2)
library(gridExtra)
set.seed(123)
n_draws <- 1000                  # 修改 M04：相关系数抽样次数

# 1. 数据模拟（保留 M02：原版 L18—53，公式与随机数顺序不变）
years <- 1990:2019
age_starts <- seq(0, 85, by = 5)
age_groups <- paste0(age_starts, "-", age_starts + 4)
age_groups[length(age_groups)] <- "85+"
data <- expand.grid(Year = years, Age_Group = age_groups)
age_mids <- c(seq(2.5, 82.5, by = 5), 90) # 90仅沿用原模拟的85+代表值
data$Age_Mid <- rep(age_mids, each = length(years))
data$Pop <- round(runif(nrow(data), 10000, 50000) *
                    (1 + (data$Age_Mid / 100)^2))
true_rate <- function(age, year) {
  time_idx <- year - 1990
  base_risk <- -12 + 0.12 * age
  time_trend <- -0.02 * time_idx
  interaction <- 0.0005 * age * time_idx
  noise <- rnorm(length(age), 0, 0.05)
  young_rebound <- ifelse(age < 50 & year > 2010, 0.05 * (year - 2010), 0)
  exp(base_risk + time_trend - interaction + young_rebound + noise)
}
data$Rate_True <- true_rate(data$Age_Mid, data$Year)
data$Deaths <- rpois(nrow(data), data$Pop * data$Rate_True)
data$Mortality_Rate <- data$Deaths / data$Pop * 100000

# 2. 曲面拟合（修改 M03：原版 L66—68，准Poisson改负二项，采用REML）
# 二维样条和人口偏置项保留；这是建模选择，不自动保证优于原版。
model_blsd <- gam(
  Deaths ~ te(Age_Mid, Year, k = c(10, 10), bs = c("cr", "cr")) +
    offset(log(Pop)),
  family = nb(link = "log"), method = "REML", data = data
)
summary(model_blsd)

# 修改 M04：抽取相关系数并传播到曲面和动态量，不只画点估计。
# 优先用Vc，否则Vp；这是经验贝叶斯高斯近似。
set.seed(123)
V <- if (!is.null(model_blsd$Vc)) model_blsd$Vc else model_blsd$Vp
ev <- eigen((V + t(V)) / 2, symmetric = TRUE)
z <- matrix(rnorm(length(coef(model_blsd)) * n_draws),
            nrow = length(coef(model_blsd)))
beta_draws <- sweep(ev$vectors %*% (sqrt(pmax(ev$values, 0)) * z),
                    1, coef(model_blsd), "+")
rm(z)

# 3. 指标与绘图
# 修改 M05：原版 L77—83延伸到92.5岁；现只预测观测年龄/时期范围。
# Pop=1的预测矩阵给出每人对数率；用均匀年龄网格简化绘图。
pred_grid <- expand.grid(Age_Mid = seq(2.5, 90, by = 0.5), Year = years)
pred_grid$Pop <- 1
X <- predict(model_blsd, newdata = pred_grid, type = "lpmatrix")
eta_draws <- X %*% beta_draws

# 修改 M06、M07：原版 L85—96的加速度直接diff展开向量，会跨年龄做差。
# 现按同点预测矩阵求导，只保留连续导数这一套。
design_at <- function(variable, delta) {
  nd <- pred_grid
  bounds <- range(pred_grid[[variable]])
  nd[[variable]] <- pmin(bounds[2], pmax(bounds[1], nd[[variable]] + delta))
  predict(model_blsd, newdata = nd, type = "lpmatrix")
}
derivative_design <- function(variable, order = 1, h = 0.01) {
  xp <- design_at(variable, h)
  xm <- design_at(variable, -h)
  edge_low <- pred_grid[[variable]] == min(pred_grid[[variable]])
  edge_high <- pred_grid[[variable]] == max(pred_grid[[variable]])
  if (order == 2) {
    out <- (xp - 2 * X + xm) / h^2
    # 自然三次样条端点二阶导数为结构性零，不是数据证明无加速度。
    out[edge_low | edge_high, ] <- 0
  } else {
    out <- (xp - xm) / (2 * h)
    out[edge_low, ] <- (-3 * X + 4 * xp - design_at(variable, 2 * h))[edge_low, ] / (2 * h)
    out[edge_high, ] <- (3 * X - 4 * xm + design_at(variable, -2 * h))[edge_high, ] / (2 * h)
  }
  out
}
velocity_draws <- derivative_design("Year") %*% beta_draws
acceleration_draws <- derivative_design("Year", order = 2) %*% beta_draws
age_gradient_draws <- derivative_design("Age_Mid") %*% beta_draws

# 必要的汇总：均值与95%逐点区间；小分母产生的缺失保留为NA。
summarise_draws <- function(draws) {
  draws[!is.finite(draws)] <- NA_real_
  values <- t(apply(draws, 1, function(x) {
    if (all(is.na(x))) return(c(NA_real_, NA_real_, NA_real_))
    c(mean(x, na.rm = TRUE), quantile(x, c(0.025, 0.975),
                                    na.rm = TRUE, names = FALSE))
  }))
  data.frame(pred_grid[c("Age_Mid", "Year")],
             Value = values[, 1], Lower = values[, 2], Upper = values[, 3])
}
surface <- summarise_draws(exp(eta_draws) * 100000)
acceleration <- summarise_draws(acceleration_draws)
# 修改 M09：每次抽样先换算，再汇总；百分比为局部一年/一岁近似。
velocity_percent <- summarise_draws(100 * expm1(velocity_draws))
age_percent <- summarise_draws(100 * expm1(age_gradient_draws))
# 修改 M10：原版只有等率线；新增移动速度，单位岁/年，不是等效年龄值。
# 小分母会产生不稳定比值，这个必要的处理保留。
iso_draws <- -velocity_draws / age_gradient_draws
iso_draws[abs(age_gradient_draws) < 0.005 | !is.finite(iso_draws)] <- NA_real_
iso <- summarise_draws(iso_draws)
iso$Retained <- rowMeans(is.finite(iso_draws))
iso$Value[iso$Retained < 0.95] <- NA_real_

# 共用绘图样式；颜色表示均值，不代表显著性。
theme_set(theme_minimal(base_size = 11))
field_plot <- function(frame, title, legend) {
  ggplot(frame, aes(Year, Age_Mid, fill = Value)) +
    geom_raster() +
    scale_fill_gradient2(low = "#2166AC", mid = "white", high = "#B2182B",
                         midpoint = 0, na.value = "grey75", name = legend) +
    labs(title = title, x = "Calendar year", y = "Age (years)")
}

# 图1：原版 L101—109曲面与等率线；删除“生理衰老推迟”的解释。
# 用ggplot2原生等高线减少依赖，图例明确每10万人死亡率。
p1 <- ggplot(surface, aes(Year, Age_Mid)) +
  geom_raster(aes(fill = Value)) +
  geom_contour(aes(z = log(Value)), bins = 12, colour = "white", linewidth = 0.3) +
  scale_fill_viridis_c(trans = "log10", name = "Deaths per 100,000") +
  labs(title = "Mortality surface and equal-mortality contours",
       x = "Calendar year", y = "Age (years)")

# 图2：原版 L115—123实际是一阶速度；现换算为百分比（M06、M09）。
# 保留原版等高线：线与颜色都表示相同的局部年度变化百分比。
p2 <- field_plot(velocity_percent, "Local annual mortality change",
                 "Relative change (%)") +
  geom_contour(aes(x = Year, y = Age_Mid, z = Value), inherit.aes = FALSE,
               bins = 10, colour = "black", linewidth = 0.25, alpha = 0.35) +
  labs(caption = "Local one-calendar-year approximation; contours show equal relative change (%).")

# 图3：新增真正的二阶时间导数，保持对数率/年²单位（M06）。
p3 <- field_plot(acceleration, "Temporal acceleration of log mortality",
                 "Log-rate / year^2") +
  labs(caption = "Endpoint zeros follow the natural cubic spline boundary condition.")

# 图4：保留原版 L128—139队列残差图，仅作计数诊断（M11）。
data$Resid <- residuals(model_blsd, type = "deviance")
data$Cohort <- data$Year - data$Age_Mid
p4 <- ggplot(data, aes(Cohort, Resid)) +
  geom_point(aes(colour = Age_Mid), alpha = 0.5) +
  geom_smooth(method = "loess", formula = y ~ x, se = FALSE, colour = "black") +
  geom_hline(yintercept = 0, linetype = "dashed") +
  scale_colour_viridis_c(name = "Age") +
  labs(title = "Count residuals viewed by birth cohort",
       subtitle = "Descriptive residual pattern, not an estimated cohort effect.",
       x = "Approximate birth year", y = "Deviance residual")

# 图5：原版 L146的round(Year)会混入邻年；改为准确选择年份（M12）。
profiles <- subset(surface, Year %in% c(1990, 2005, 2019))
profiles$Period <- factor(profiles$Year)
observed_profiles <- subset(data, Year %in% c(1990, 2005, 2019) & Mortality_Rate > 0)
observed_profiles$Period <- factor(observed_profiles$Year)
p5 <- ggplot(profiles, aes(Age_Mid, Value, colour = Period, fill = Period)) +
  geom_ribbon(aes(ymin = Lower, ymax = Upper), alpha = 0.12, colour = NA) +
  geom_line(linewidth = 0.8) +
  geom_point(data = observed_profiles, aes(y = Mortality_Rate), size = 1.3) +
  scale_y_log10() +
  labs(title = "Age profiles in selected years", x = "Age (years)",
       y = "Deaths per 100,000", caption = "95% pointwise intervals; observed zeros omitted on this log scale.")

# 图6：选定观测年龄的时间趋势及区间（M13）。
trend_ages <- c(7.5, 22.5, 42.5, 62.5, 82.5, 90)
trends <- subset(surface, Age_Mid %in% trend_ages)
observed_trends <- subset(data, Age_Mid %in% trend_ages)
p6 <- ggplot(trends, aes(Year, Value)) +
  geom_ribbon(aes(ymin = Lower, ymax = Upper), fill = "#2C7FB8", alpha = 0.2) +
  geom_line(colour = "#2166AC") +
  geom_point(data = observed_trends, aes(y = Mortality_Rate), size = 1.1) +
  facet_wrap(~Age_Mid, scales = "free_y", ncol = 3) +
  labs(title = "Mortality trends at selected ages", x = "Calendar year",
       y = "Deaths per 100,000", caption = "Points: observed rates. Ribbons: 95% pointwise intervals.")

# 图7：年龄梯度换成百分比，并展示等死亡率移动速度（M07、M09、M10）。
# 两图协调使用绿色：左图浅绿到深绿表示大小，右图紫负、白零、绿正。
p7_theme <- theme(legend.position = "bottom", plot.title = element_text(size = 11),
                  plot.caption = element_text(size = 8))
p7_age <- ggplot(age_percent, aes(Year, Age_Mid, fill = Value)) +
  geom_raster() +
  scale_fill_gradient(low = "#E5F5E0", high = "#238B45", na.value = "grey75",
                      name = "Relative change (%)") +
  labs(title = "A. Local age-associated change", x = "Calendar year", y = "Age (years)",
       caption = "Local one-age-year approximation.") + p7_theme
iso_limit <- max(abs(iso$Value), na.rm = TRUE)
p7_iso <- ggplot(iso, aes(Year, Age_Mid, fill = Value)) +
  geom_raster() +
  scale_fill_gradient2(low = "#756BB1", mid = "#F7F7F7", high = "#238B45",
                       midpoint = 0, limits = c(-iso_limit, iso_limit),
                       na.value = "grey75", name = "Age-years / year") +
  labs(title = "B. Equal-mortality age movement", x = "Calendar year", y = "Age (years)",
       caption = "Purple: lower-age shift; green: higher-age shift.\nGrey: fewer than 95% of draws retained.") + p7_theme

# 4. 在RStudio中显示，与原版一样不保存图片、表格或模型文件。
# 前六张图进入Plots历史，图7左右并列；点击上一张/下一张查看。
for (p in list(p1, p2, p3, p4, p5, p6)) print(p)
grid.arrange(p7_age, p7_iso, ncol = 2)

