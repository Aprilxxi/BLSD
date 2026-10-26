# BLSD Tool：可选择拟合方法的分析脚本，输出七张图。
# 首次使用：install.packages(c("mgcv", "ggplot2", "gridExtra"))
# 在 RStudio 中修改下方 blsd_config，然后点击 Source 运行整个文件。
# 默认示例与网页完全相同，共 442 行；不重新生成模拟数据。
# 自备 CSV：input_csv = "你的数据.csv"；默认 NULL 使用内置示例。
# distribution = "quasipoisson"（准 Poisson）或 "nb"（负二项）；
# smoothing = "GCV" 或 "REML"。与网页一样支持三种有效组合：
# 准 Poisson + GCV、准 Poisson + REML、负二项 + REML。
# 负二项 + GCV 会明确报错，不会静默改用 REML 或 UBRE。
# 输入列：Year、Age_Group（或 Age_Mid）、Count（或 Deaths）、Pop；
# 可选 Sex 列。多个性别分别拟合，绝不混合；30-34 的年龄中点为 32.5。
# 七张图依次为曲面、年度变化、加速度、拟合率与偏差残差、年龄截面、
# 年龄别时期趋势，以及年龄梯度和等死亡率年龄移动速度并列图。
# 默认在 Plots 中显示；设置 output_dir = "BLSD_figures" 可保存 PDF/PNG。
# 仅加载函数：options(blsd.skip_autorun = TRUE)，再 source 此文件。
# 运行后 blsd_result 保留每组模型、同一套系数抽样、数值表、诊断及绘图对象。
# 每组自动报告基维度检查：k-index、近似 P 值及 EDF；400 次置换使用独立随机流。
# 稿件符号：g_t 为时间斜率，g_a 为年龄斜率，c_t 为时间曲率；
# A_t=100*expm1(g_t)，A_a=100*expm1(g_a)，v=-g_t/g_a 为等率年龄移动。
#
# BLSD Tool: selectable count/exposure analysis and seven figures.
# Requires R >= 4.1 and: install.packages(c("mgcv", "ggplot2", "gridExtra"))
# Edit this configuration, then Source the entire file in RStudio.
# input_csv = NULL uses the EXACT fixed example from the webpage (442 rows).
# Supply Year, Age_Group (or Age_Mid), Count (or Deaths), Pop; Sex is optional.
# Each supplied Sex is fitted separately. No sexes are pooled or invented.
#
# Supported combinations match the webpage: quasi-Poisson + GCV,
# quasi-Poisson + REML, and negative binomial + REML (theta estimated).
# NB + GCV is rejected: mgcv::nb() changes it to REML and negbin() uses
# UBRE. These criteria must not be mislabeled as GCV.
# Official mgcv reference:
# https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/negbin.html
# https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/gam.html
#
# Seven figures: surface, annual change, log-rate curvature, fitted-rate residuals,
# age profiles, period trends, and a two-panel age-gradient / age-shift figure.
# Intervals are approximate 95% pointwise intervals, not predictive intervals.
# To load functions only: options(blsd.skip_autorun = TRUE); source(this_file)
# Then: result <- blsd_run(modifyList(blsd_config, list(distribution="quasipoisson", smoothing="GCV")))

blsd_config <- list(
  input_csv = NULL,
  distribution = "nb",             # "nb" or "quasipoisson"
  smoothing = "REML",              # "REML" or "GCV"
  draws = 1000L, seed = 123L,
  k_age = 10L, k_period = 10L,
  gradient_threshold = 0.005,
  section_years = NULL,             # NULL: 1990/2005/2023 for the built-in example
  trend_ages = NULL,                # NULL: up to six observed ages
  selected_sexes = NULL,            # NULL: all supplied groups, independently
  display = TRUE,
  output_dir = NULL,                # e.g. "BLSD_figures"; NULL writes no files
  formats = c("pdf", "png"), dpi = 600L
)

# Exact original UTF-8 CSV bytes (CRLF newlines, final newline included).
# SHA-256: 5d2b2edac8329cedf6b2fecb29fbb046b62b892dfba27255c9d4541575a0f46c
# INDEPENDENT_SYNTHETIC_COUNT_EXPOSURE; simulated=TRUE; derived=FALSE.
# Generation seed=20261022; BLSD-INDEPENDENT-SYNTHETIC-20261022-v1.
# The generating NB size=300 is NOT a known fitted theta.
# Fixed manuscript data-generating mechanism (documentation only; never sampled here):
# x=(a-62.5)/30, u=(t-2005)/15;
# r(a,t)=(250/100000)*exp(3.2*x - 0.9*x^2 - (0.55-0.12*x)*u + 0.08*u^3).
# P(a)=round(2000000*exp(-0.03*(a-32.5))).
# Y(a,t) ~ NB(mu=P(a)*r(a,t), size=300), Var(Y)=mu+mu^2/300.
# The 442 fixed observations below are the original single realization.
# Analysis treats denominators as fixed and cells as conditionally independent.
blsd_example_csv <- '"Year","Age_Group","Count","Pop"
1990,"30-34",134,2e+06
1990,"35-39",276,1721416
1990,"40-44",535,1481636
1990,"45-49",955,1275256
1990,"50-54",1346,1097623
1990,"55-59",2208,944733
1990,"60-64",3329,813139
1990,"65-69",4515,699875
1990,"70-74",6291,602388
1990,"75-79",8289,518481
1990,"80-84",8986,446260
1990,"85-89",10185,384100
1990,"90-94",11402,330598
1991,"30-34",148,2e+06
1991,"35-39",252,1721416
1991,"40-44",504,1481636
1991,"45-49",884,1275256
1991,"50-54",1316,1097623
1991,"55-59",2243,944733
1991,"60-64",3195,813139
1991,"65-69",4872,699875
1991,"70-74",6573,602388
1991,"75-79",7253,518481
1991,"80-84",9210,446260
1991,"85-89",10697,384100
1991,"90-94",11534,330598
1992,"30-34",136,2e+06
1992,"35-39",294,1721416
1992,"40-44",472,1481636
1992,"45-49",804,1275256
1992,"50-54",1365,1097623
1992,"55-59",2075,944733
1992,"60-64",3011,813139
1992,"65-69",4938,699875
1992,"70-74",5717,602388
1992,"75-79",7004,518481
1992,"80-84",9245,446260
1992,"85-89",11027,384100
1992,"90-94",12346,330598
1993,"30-34",135,2e+06
1993,"35-39",284,1721416
1993,"40-44",470,1481636
1993,"45-49",713,1275256
1993,"50-54",1275,1097623
1993,"55-59",1943,944733
1993,"60-64",2604,813139
1993,"65-69",4333,699875
1993,"70-74",5730,602388
1993,"75-79",7017,518481
1993,"80-84",9274,446260
1993,"85-89",9353,384100
1993,"90-94",11136,330598
1994,"30-34",130,2e+06
1994,"35-39",264,1721416
1994,"40-44",480,1481636
1994,"45-49",737,1275256
1994,"50-54",1420,1097623
1994,"55-59",2030,944733
1994,"60-64",2972,813139
1994,"65-69",4103,699875
1994,"70-74",5231,602388
1994,"75-79",7186,518481
1994,"80-84",8459,446260
1994,"85-89",10259,384100
1994,"90-94",11150,330598
1995,"30-34",142,2e+06
1995,"35-39",241,1721416
1995,"40-44",402,1481636
1995,"45-49",744,1275256
1995,"50-54",1243,1097623
1995,"55-59",2021,944733
1995,"60-64",2921,813139
1995,"65-69",4043,699875
1995,"70-74",5494,602388
1995,"75-79",6416,518481
1995,"80-84",8738,446260
1995,"85-89",9347,384100
1995,"90-94",10689,330598
1996,"30-34",122,2e+06
1996,"35-39",240,1721416
1996,"40-44",413,1481636
1996,"45-49",712,1275256
1996,"50-54",1122,1097623
1996,"55-59",1703,944733
1996,"60-64",2758,813139
1996,"65-69",3850,699875
1996,"70-74",5381,602388
1996,"75-79",6397,518481
1996,"80-84",7754,446260
1996,"85-89",8465,384100
1996,"90-94",10758,330598
1997,"30-34",102,2e+06
1997,"35-39",211,1721416
1997,"40-44",438,1481636
1997,"45-49",706,1275256
1997,"50-54",1185,1097623
1997,"55-59",1830,944733
1997,"60-64",2781,813139
1997,"65-69",3606,699875
1997,"70-74",4797,602388
1997,"75-79",6982,518481
1997,"80-84",8973,446260
1997,"85-89",10035,384100
1997,"90-94",9956,330598
1998,"30-34",107,2e+06
1998,"35-39",223,1721416
1998,"40-44",385,1481636
1998,"45-49",663,1275256
1998,"50-54",1071,1097623
1998,"55-59",1743,944733
1998,"60-64",2666,813139
1998,"65-69",3441,699875
1998,"70-74",4742,602388
1998,"75-79",6932,518481
1998,"80-84",7698,446260
1998,"85-89",9227,384100
1998,"90-94",10177,330598
1999,"30-34",109,2e+06
1999,"35-39",206,1721416
1999,"40-44",372,1481636
1999,"45-49",639,1275256
1999,"50-54",1192,1097623
1999,"55-59",1796,944733
1999,"60-64",2827,813139
1999,"65-69",3848,699875
1999,"70-74",4924,602388
1999,"75-79",5906,518481
1999,"80-84",7796,446260
1999,"85-89",9028,384100
1999,"90-94",10022,330598
2000,"30-34",109,2e+06
2000,"35-39",183,1721416
2000,"40-44",342,1481636
2000,"45-49",623,1275256
2000,"50-54",1145,1097623
2000,"55-59",1684,944733
2000,"60-64",2624,813139
2000,"65-69",3406,699875
2000,"70-74",4569,602388
2000,"75-79",6418,518481
2000,"80-84",7173,446260
2000,"85-89",8899,384100
2000,"90-94",9252,330598
2001,"30-34",109,2e+06
2001,"35-39",190,1721416
2001,"40-44",349,1481636
2001,"45-49",701,1275256
2001,"50-54",1028,1097623
2001,"55-59",1568,944733
2001,"60-64",2127,813139
2001,"65-69",3447,699875
2001,"70-74",4366,602388
2001,"75-79",6074,518481
2001,"80-84",8091,446260
2001,"85-89",8143,384100
2001,"90-94",8573,330598
2002,"30-34",69,2e+06
2002,"35-39",193,1721416
2002,"40-44",353,1481636
2002,"45-49",578,1275256
2002,"50-54",1004,1097623
2002,"55-59",1600,944733
2002,"60-64",2167,813139
2002,"65-69",3080,699875
2002,"70-74",4092,602388
2002,"75-79",6026,518481
2002,"80-84",6617,446260
2002,"85-89",8539,384100
2002,"90-94",8054,330598
2003,"30-34",99,2e+06
2003,"35-39",168,1721416
2003,"40-44",357,1481636
2003,"45-49",566,1275256
2003,"50-54",839,1097623
2003,"55-59",1400,944733
2003,"60-64",2039,813139
2003,"65-69",3236,699875
2003,"70-74",4036,602388
2003,"75-79",5367,518481
2003,"80-84",7020,446260
2003,"85-89",7447,384100
2003,"90-94",8896,330598
2004,"30-34",72,2e+06
2004,"35-39",167,1721416
2004,"40-44",295,1481636
2004,"45-49",464,1275256
2004,"50-54",824,1097623
2004,"55-59",1378,944733
2004,"60-64",2086,813139
2004,"65-69",2926,699875
2004,"70-74",4214,602388
2004,"75-79",5393,518481
2004,"80-84",6272,446260
2004,"85-89",7431,384100
2004,"90-94",8337,330598
2005,"30-34",65,2e+06
2005,"35-39",194,1721416
2005,"40-44",355,1481636
2005,"45-49",508,1275256
2005,"50-54",829,1097623
2005,"55-59",1234,944733
2005,"60-64",2005,813139
2005,"65-69",3121,699875
2005,"70-74",3472,602388
2005,"75-79",5368,518481
2005,"80-84",6348,446260
2005,"85-89",7133,384100
2005,"90-94",9096,330598
2006,"30-34",78,2e+06
2006,"35-39",134,1721416
2006,"40-44",277,1481636
2006,"45-49",518,1275256
2006,"50-54",844,1097623
2006,"55-59",1354,944733
2006,"60-64",2332,813139
2006,"65-69",2713,699875
2006,"70-74",4033,602388
2006,"75-79",5180,518481
2006,"80-84",5859,446260
2006,"85-89",7815,384100
2006,"90-94",7313,330598
2007,"30-34",93,2e+06
2007,"35-39",139,1721416
2007,"40-44",264,1481636
2007,"45-49",421,1275256
2007,"50-54",796,1097623
2007,"55-59",1303,944733
2007,"60-64",2152,813139
2007,"65-69",2707,699875
2007,"70-74",3961,602388
2007,"75-79",4943,518481
2007,"80-84",5770,446260
2007,"85-89",7011,384100
2007,"90-94",6690,330598
2008,"30-34",57,2e+06
2008,"35-39",137,1721416
2008,"40-44",245,1481636
2008,"45-49",439,1275256
2008,"50-54",757,1097623
2008,"55-59",1269,944733
2008,"60-64",1738,813139
2008,"65-69",2438,699875
2008,"70-74",3819,602388
2008,"75-79",4921,518481
2008,"80-84",5463,446260
2008,"85-89",7192,384100
2008,"90-94",7874,330598
2009,"30-34",70,2e+06
2009,"35-39",131,1721416
2009,"40-44",208,1481636
2009,"45-49",415,1275256
2009,"50-54",817,1097623
2009,"55-59",1091,944733
2009,"60-64",1855,813139
2009,"65-69",2572,699875
2009,"70-74",3202,602388
2009,"75-79",4756,518481
2009,"80-84",5763,446260
2009,"85-89",7409,384100
2009,"90-94",7185,330598
2010,"30-34",66,2e+06
2010,"35-39",130,1721416
2010,"40-44",237,1481636
2010,"45-49",393,1275256
2010,"50-54",784,1097623
2010,"55-59",1313,944733
2010,"60-64",1672,813139
2010,"65-69",2276,699875
2010,"70-74",3427,602388
2010,"75-79",4415,518481
2010,"80-84",5342,446260
2010,"85-89",6802,384100
2010,"90-94",7187,330598
2011,"30-34",61,2e+06
2011,"35-39",142,1721416
2011,"40-44",263,1481636
2011,"45-49",397,1275256
2011,"50-54",733,1097623
2011,"55-59",1061,944733
2011,"60-64",1679,813139
2011,"65-69",2408,699875
2011,"70-74",3081,602388
2011,"75-79",4019,518481
2011,"80-84",5786,446260
2011,"85-89",6221,384100
2011,"90-94",6394,330598
2012,"30-34",73,2e+06
2012,"35-39",138,1721416
2012,"40-44",232,1481636
2012,"45-49",393,1275256
2012,"50-54",687,1097623
2012,"55-59",1126,944733
2012,"60-64",1710,813139
2012,"65-69",2311,699875
2012,"70-74",3016,602388
2012,"75-79",4531,518481
2012,"80-84",4787,446260
2012,"85-89",6170,384100
2012,"90-94",6574,330598
2013,"30-34",64,2e+06
2013,"35-39",100,1721416
2013,"40-44",217,1481636
2013,"45-49",429,1275256
2013,"50-54",619,1097623
2013,"55-59",866,944733
2013,"60-64",1601,813139
2013,"65-69",2251,699875
2013,"70-74",2935,602388
2013,"75-79",4338,518481
2013,"80-84",4219,446260
2013,"85-89",6078,384100
2013,"90-94",6327,330598
2014,"30-34",47,2e+06
2014,"35-39",101,1721416
2014,"40-44",222,1481636
2014,"45-49",339,1275256
2014,"50-54",573,1097623
2014,"55-59",933,944733
2014,"60-64",1486,813139
2014,"65-69",2019,699875
2014,"70-74",2764,602388
2014,"75-79",4055,518481
2014,"80-84",5344,446260
2014,"85-89",5418,384100
2014,"90-94",6046,330598
2015,"30-34",58,2e+06
2015,"35-39",91,1721416
2015,"40-44",180,1481636
2015,"45-49",350,1275256
2015,"50-54",552,1097623
2015,"55-59",951,944733
2015,"60-64",1527,813139
2015,"65-69",1893,699875
2015,"70-74",2840,602388
2015,"75-79",3875,518481
2015,"80-84",5208,446260
2015,"85-89",5236,384100
2015,"90-94",5902,330598
2016,"30-34",53,2e+06
2016,"35-39",98,1721416
2016,"40-44",222,1481636
2016,"45-49",333,1275256
2016,"50-54",545,1097623
2016,"55-59",859,944733
2016,"60-64",1303,813139
2016,"65-69",1930,699875
2016,"70-74",2742,602388
2016,"75-79",3603,518481
2016,"80-84",4595,446260
2016,"85-89",6036,384100
2016,"90-94",5705,330598
2017,"30-34",58,2e+06
2017,"35-39",100,1721416
2017,"40-44",190,1481636
2017,"45-49",313,1275256
2017,"50-54",539,1097623
2017,"55-59",875,944733
2017,"60-64",1371,813139
2017,"65-69",2038,699875
2017,"70-74",2455,602388
2017,"75-79",3272,518481
2017,"80-84",4291,446260
2017,"85-89",5067,384100
2017,"90-94",5295,330598
2018,"30-34",40,2e+06
2018,"35-39",103,1721416
2018,"40-44",204,1481636
2018,"45-49",394,1275256
2018,"50-54",573,1097623
2018,"55-59",779,944733
2018,"60-64",1364,813139
2018,"65-69",1920,699875
2018,"70-74",2475,602388
2018,"75-79",3272,518481
2018,"80-84",4343,446260
2018,"85-89",4800,384100
2018,"90-94",6401,330598
2019,"30-34",49,2e+06
2019,"35-39",79,1721416
2019,"40-44",165,1481636
2019,"45-49",334,1275256
2019,"50-54",446,1097623
2019,"55-59",865,944733
2019,"60-64",1358,813139
2019,"65-69",1872,699875
2019,"70-74",2861,602388
2019,"75-79",3432,518481
2019,"80-84",4277,446260
2019,"85-89",5213,384100
2019,"90-94",5979,330598
2020,"30-34",61,2e+06
2020,"35-39",101,1721416
2020,"40-44",170,1481636
2020,"45-49",345,1275256
2020,"50-54",533,1097623
2020,"55-59",804,944733
2020,"60-64",1292,813139
2020,"65-69",1808,699875
2020,"70-74",2674,602388
2020,"75-79",3198,518481
2020,"80-84",4392,446260
2020,"85-89",5214,384100
2020,"90-94",5824,330598
2021,"30-34",58,2e+06
2021,"35-39",89,1721416
2021,"40-44",179,1481636
2021,"45-49",334,1275256
2021,"50-54",528,1097623
2021,"55-59",736,944733
2021,"60-64",1296,813139
2021,"65-69",1845,699875
2021,"70-74",2480,602388
2021,"75-79",2972,518481
2021,"80-84",4202,446260
2021,"85-89",5191,384100
2021,"90-94",5857,330598
2022,"30-34",46,2e+06
2022,"35-39",78,1721416
2022,"40-44",145,1481636
2022,"45-49",283,1275256
2022,"50-54",533,1097623
2022,"55-59",882,944733
2022,"60-64",1242,813139
2022,"65-69",1920,699875
2022,"70-74",2622,602388
2022,"75-79",2986,518481
2022,"80-84",4289,446260
2022,"85-89",5231,384100
2022,"90-94",5590,330598
2023,"30-34",54,2e+06
2023,"35-39",89,1721416
2023,"40-44",147,1481636
2023,"45-49",307,1275256
2023,"50-54",497,1097623
2023,"55-59",752,944733
2023,"60-64",1109,813139
2023,"65-69",1778,699875
2023,"70-74",2363,602388
2023,"75-79",3289,518481
2023,"80-84",3847,446260
2023,"85-89",5399,384100
2023,"90-94",5489,330598
'

blsd_example_csv <- gsub("\n", "\r\n", blsd_example_csv, fixed = TRUE)

blsd_example_data <- function() {
  read.csv(text = blsd_example_csv, stringsAsFactors = FALSE, check.names = FALSE)
}

blsd_require <- function() {
  needed <- c("mgcv", "ggplot2", "gridExtra")
  missing <- needed[!vapply(needed, requireNamespace, logical(1), quietly = TRUE)]
  if (length(missing)) stop("Install required R packages: ", paste(missing, collapse = ", "), call. = FALSE)
}

blsd_validate_input <- function(data) {
  if (!is.data.frame(data) || !nrow(data)) stop("Input must be a non-empty data frame.")
  if (anyDuplicated(names(data))) stop("Duplicate column names are not allowed.")
  if (!all(c("Year", "Pop") %in% names(data))) stop("Required columns: Year, Pop, Age_Group or Age_Mid, Count or Deaths.")
  if ("Count" %in% names(data)) {
    if ("Deaths" %in% names(data) && !isTRUE(all.equal(data$Count, data$Deaths, check.attributes = FALSE)))
      stop("Count and Deaths disagree. Supply one count column.")
    data$Deaths <- data$Count
  }
  if (!"Deaths" %in% names(data)) stop("Supply Count or Deaths.")
  if ("Age_Group" %in% names(data)) {
    labels <- trimws(as.character(data$Age_Group))
    labels <- sub("\\s*(years?|\u5c81)\\s*$", "", labels, ignore.case = TRUE)
    labels <- gsub("\u2013", "-", labels, fixed = TRUE)
    valid <- !is.na(labels) & grepl("^[0-9]+\\s*-\\s*[0-9]+$", labels)
    if (!all(valid)) stop("Age_Group must contain closed integer ranges such as 30-34; open groups are unsupported.")
    parts <- strsplit(gsub("\\s+", "", labels), "-", fixed = TRUE)
    lo <- vapply(parts, function(x) as.numeric(x[1]), numeric(1))
    hi <- vapply(parts, function(x) as.numeric(x[2]), numeric(1))
    if (any(!is.finite(lo) | !is.finite(hi) | hi < lo)) stop("Invalid age-group bounds.")
    mid <- (lo + hi + 1) / 2
    if ("Age_Mid" %in% names(data) && (!is.numeric(data$Age_Mid) || any(!is.finite(data$Age_Mid) | abs(data$Age_Mid - mid) > 1e-10)))
      stop("Age_Mid disagrees with Age_Group: completed-age group 30-34 has midpoint 32.5.")
    data$Age_Mid <- mid
    data$Age_Lower <- lo
    data$Age_Upper <- hi
  }
  numeric_columns <- c("Year", "Age_Mid", "Deaths", "Pop")
  if (!all(numeric_columns %in% names(data)) || !all(vapply(data[numeric_columns], is.numeric, logical(1))))
    stop("Year, Age_Mid, Count/Deaths and Pop must be numeric.")
  if (any(!is.finite(as.matrix(data[numeric_columns])))) stop("Input contains missing or non-finite numeric values.")
  if (any(data$Pop <= 0 | data$Deaths < 0 | data$Age_Mid < 0)) stop("Pop must be positive; counts and ages must be nonnegative.")
  if ("Sex" %in% names(data)) {
    data$Sex <- trimws(as.character(data$Sex))
    if (anyNA(data$Sex) || any(!nzchar(data$Sex))) stop("Every row must have a Sex label when Sex is supplied.")
  }
  data
}

blsd_derivative <- function(model, grid, variable, domain, h, order = 1L, base_lpmatrix = NULL) {
  x <- grid[[variable]]
  kind <- ifelse(x - h < domain[1], "forward", ifelse(x + h > domain[2], "backward", "central"))
  result <- matrix(0, nrow(grid), length(stats::coef(model)))
  cancellation <- numeric(nrow(grid))
  for (method in unique(kind)) {
    ix <- which(kind == method)
    nodes <- if (method == "central") c(-1, 0, 1) else if (order == 1L) 0:2 else 0:3
    weights <- if (method == "central") {
      if (order == 1L) c(-0.5, 0, 0.5) else c(1, -2, 1)
    } else if (order == 1L) c(-1.5, 2, -0.5) else c(2, -5, 4, -1)
    if (method == "backward") {
      nodes <- -nodes
      if (order == 1L) weights <- -weights
    }
    for (j in seq_along(nodes)) {
      nd <- grid[ix, , drop = FALSE]
      nd[[variable]] <- x[ix] + nodes[j] * h
      xp <- if (nodes[j] == 0 && !is.null(base_lpmatrix)) base_lpmatrix[ix, , drop = FALSE]
        else stats::predict(model, newdata = nd, type = "lpmatrix")
      result[ix, ] <- result[ix, , drop = FALSE] + weights[j] * xp
      cancellation[ix] <- cancellation[ix] + abs(weights[j]) * apply(abs(xp), 1L, max)
    }
  }
  zeroed <- apply(abs(result), 1L, max) <= 64 * .Machine$double.eps * cancellation
  result[zeroed, ] <- 0
  if (order == 2L) result[x == domain[1] | x == domain[2], ] <- 0
  result / h^order
}

blsd_summarize <- function(draws, centers) {
  fraction <- rowMeans(is.finite(draws))
  valid <- is.finite(centers) & fraction == 1
  bounds <- matrix(NA_real_, nrow(draws), 2L)
  if (any(valid)) bounds[valid, ] <- t(apply(draws[valid, , drop = FALSE], 1L,
    stats::quantile, probs = c(0.025, 0.975), names = FALSE))
  centers[!valid] <- NA_real_
  list(center = centers, interval = bounds, fraction = fraction)
}

blsd_axis <- function(observed, count) {
  if (length(observed) <= count) {
    extra <- max(2L, count - length(observed) + 2L)
    sort(unique(c(observed, seq(min(observed), max(observed), length.out = extra))))
  } else observed
}

blsd_choose <- function(axis, requested, count) {
  if (is.null(requested)) return(axis[unique(round(seq(1L, length(axis), length.out = min(count, length(axis)))) )])
  if (!is.numeric(requested) || !length(requested) || any(!is.finite(requested)) || any(requested < min(axis) | requested > max(axis)))
    stop("Selected curve coordinates must be finite and inside the observed range.")
  sort(unique(requested))
}

# Basis diagnostics use only the retained fit and their own reproducible RNG stream.
# Restoring both RNGkind and .Random.seed keeps model/interval draws unchanged.
blsd_basis_diagnostics <- function(model, seed = 20261015L, replicates = 400L, subsample = 5000L) {
  rng_kind <- RNGkind()
  had_seed <- exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  if (had_seed) saved_seed <- get(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  on.exit({
    do.call(RNGkind, as.list(rng_kind))
    if (had_seed) assign(".Random.seed", saved_seed, envir = .GlobalEnv)
    else if (exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) rm(".Random.seed", envir = .GlobalEnv)
  }, add = TRUE)
  RNGkind("Mersenne-Twister", "Inversion", "Rejection")
  set.seed(seed)
  warnings <- character()
  error_message <- NULL
  check <- tryCatch(withCallingHandlers(
    mgcv::k.check(model, subsample = subsample, n.rep = replicates),
    warning = function(w) { warnings <<- c(warnings, conditionMessage(w)); invokeRestart("muffleWarning") }),
    error = function(e) { error_message <<- conditionMessage(e); NULL })
  terms <- vapply(model$smooth, function(x) x$label, character(1))
  if (!length(terms) && is.null(error_message)) error_message <- "No smooth terms are available for a basis-dimension check."
  checks <- data.frame(term = terms, k_prime = rep(NA_real_, length(terms)),
    edf = rep(NA_real_, length(terms)), k_index = rep(NA_real_, length(terms)),
    p_value = rep(NA_real_, length(terms)), status = rep("UNAVAILABLE", length(terms)), reason = rep("", length(terms)),
    stringsAsFactors = FALSE)
  for (i in seq_along(terms)) {
    row <- if (is.null(check)) NA_integer_ else match(terms[i], rownames(check))
    if (!is.na(row)) {
      columns <- c("k'", "edf", "k-index", "p-value")
      values <- vapply(columns, function(column) {
        if (!column %in% colnames(check)) return(NA_real_)
        value <- as.numeric(check[row, column])
        if (length(value) != 1L || !is.finite(value)) NA_real_ else value
      }, numeric(1))
      checks[i, c("k_prime", "edf", "k_index", "p_value")] <- values
      checks$status[i] <- if (all(is.finite(values))) "AVAILABLE" else "UNAVAILABLE"
    }
    if (checks$status[i] != "AVAILABLE") checks$reason[i] <- if (!is.null(error_message)) error_message else
      "mgcv::k.check did not return a finite k-index and P value for this smooth."
  }
  status <- if (!length(terms) || all(checks$status == "UNAVAILABLE")) "UNAVAILABLE" else
    if (all(checks$status == "AVAILABLE")) "AVAILABLE" else "PARTIAL"
  list(basis_checks = checks, basis_check_status = status, seed = seed, replicates = replicates,
    subsample = subsample, warnings = unique(warnings), error = error_message,
    note = "Interpret the k-index and permutation P value with EDF and fits using larger basis dimensions; small P is not a definitive test of basis adequacy.")
}

blsd_fit_one <- function(data, config, sex = NULL) {
  if (anyDuplicated(data[c("Year", "Age_Mid")])) stop("Duplicate age-period cells within a group.")
  observed_years <- sort(unique(data$Year))
  observed_ages <- sort(unique(data$Age_Mid))
  if (length(observed_years) < 5L || length(observed_ages) < 5L) stop("At least five distinct periods and five ages are required per group.")
  if ("Age_Lower" %in% names(data)) {
    bounds <- unique(data[c("Age_Lower", "Age_Upper")])
    bounds <- bounds[order(bounds$Age_Lower), ]
    if (nrow(bounds) > 1L && any(head(bounds$Age_Upper, -1L) >= tail(bounds$Age_Lower, -1L))) stop("Age groups overlap within a sex group.")
  }
  k_age <- min(config$k_age, length(observed_ages) - 1L)
  k_period <- min(config$k_period, length(observed_years) - 1L)
  if (nrow(data) <= k_age * k_period) stop("Too few observations for the requested basis dimensions.")
  family <- if (config$distribution == "quasipoisson") stats::quasipoisson(link = "log")
    else mgcv::nb(link = "log")
  method <- if (config$smoothing == "GCV") "GCV.Cp" else "REML"
  scale <- if (config$smoothing == "GCV") -1 else 0
  te <- mgcv::te
  model <- mgcv::gam(Deaths ~ te(Year, Age_Mid, k = c(k_period, k_age), bs = c("cr", "cr")) + offset(log(Pop)),
    family = family, method = method, scale = scale, data = data)
  if (!isTRUE(model$converged)) stop("The fit did not converge.")
  if (config$smoothing == "GCV" && !identical(model$method, "GCV")) stop("Requested GCV was not used by mgcv: ", model$method)
  beta <- stats::coef(model)
  covariance_source <- if (!is.null(model$Vc)) "Vc" else "Vp"
  covariance <- model[[covariance_source]]
  if (any(!is.finite(beta)) || any(!is.finite(covariance))) stop("Non-finite coefficients/covariance.")
  decomposition <- eigen((covariance + t(covariance)) / 2, symmetric = TRUE)
  tolerance <- 1e-8 * max(abs(decomposition$values), .Machine$double.eps)
  if (min(decomposition$values) < -tolerance) stop("Coefficient covariance is not positive semidefinite.")
  set.seed(config$seed)
  innovations <- matrix(stats::rnorm(length(beta) * config$draws), nrow = length(beta))
  beta_draws <- sweep(decomposition$vectors %*% (sqrt(pmax(decomposition$values, 0)) * innovations), 1, beta, "+")
  rm(innovations)
  requested_years <- config$section_years
  if (is.null(requested_years) && all(range(observed_years) == c(1990, 2023))) requested_years <- c(1990, 2005, 2023)
  section_years <- blsd_choose(observed_years, requested_years, 3L)
  requested_ages <- config$trend_ages
  example_trends <- c(32.5, 42.5, 52.5, 62.5, 82.5, 92.5)
  if (is.null(requested_ages) && all(example_trends %in% observed_ages)) requested_ages <- example_trends
  trend_ages <- blsd_choose(observed_ages, requested_ages, 6L)
  ages <- sort(unique(c(blsd_axis(observed_ages, 100L), trend_ages)))
  years <- sort(unique(c(if (length(observed_years) <= 40L) observed_years else blsd_axis(observed_years, 40L), section_years)))
  if (length(ages) * length(years) > 40000L) stop("Prediction grid exceeds 40,000 cells; reduce input coordinate density.")
  grid <- expand.grid(Age_Mid = ages, Year = years, KEEP.OUT.ATTRS = FALSE)
  grid$Pop <- 1
  h_age <- min(0.01, diff(range(ages)) / 10)
  h_period <- min(0.01, diff(range(years)) / 10)
  # Manuscript notation: eta=log(rate), g_t=d(eta)/dt, g_a=d(eta)/da,
  # c_t=d^2(eta)/dt^2, A_t=100*expm1(g_t), A_a=100*expm1(g_a), v=-g_t/g_a.
  # Legacy machine fields logAnnual/logGradient/acceleration/shift retain these meanings.
  metrics <- c("surface", "rate", "annual", "acceleration", "gradient", "shift", "logGradient", "logAnnual")
  fields <- setNames(lapply(metrics, function(x) data.frame(grid[c("Year", "Age_Mid")], Value = NA_real_, Lower = NA_real_, Upper = NA_real_,
    RawValue = NA_real_, RawLower = NA_real_, RawUpper = NA_real_, Masked = FALSE, MaskReason = "", ValidFraction = NA_real_)), metrics)
  for (first in seq(1L, nrow(grid), by = 128L)) {
    ix <- first:min(nrow(grid), first + 127L)
    nd <- grid[ix, , drop = FALSE]
    X <- stats::predict(model, newdata = nd, type = "lpmatrix")
    Dt <- blsd_derivative(model, nd, "Year", range(years), h_period, base_lpmatrix = X)
    Da <- blsd_derivative(model, nd, "Age_Mid", range(ages), h_age, base_lpmatrix = X)
    Dtt <- blsd_derivative(model, nd, "Year", range(years), h_period, 2L, base_lpmatrix = X)
    eta <- drop(X %*% beta); temporal <- drop(Dt %*% beta); age <- drop(Da %*% beta)
    acceleration <- drop(Dtt %*% beta)
    eta_draws <- X %*% beta_draws + log(100000)
    temporal_draws <- Dt %*% beta_draws; age_draws <- Da %*% beta_draws
    centers <- list(surface = eta + log(100000), rate = exp(eta) * 100000,
      annual = 100 * expm1(temporal), acceleration = acceleration, gradient = 100 * expm1(age),
      shift = -temporal / age, logGradient = age, logAnnual = temporal)
    summaries <- list(surface = blsd_summarize(eta_draws, centers$surface),
      rate = blsd_summarize(exp(eta_draws), centers$rate),
      annual = blsd_summarize(100 * expm1(temporal_draws), centers$annual),
      acceleration = blsd_summarize(Dtt %*% beta_draws, centers$acceleration),
      gradient = blsd_summarize(100 * expm1(age_draws), centers$gradient),
      shift = blsd_summarize(-temporal_draws / age_draws, centers$shift),
      logGradient = blsd_summarize(age_draws, centers$logGradient),
      logAnnual = blsd_summarize(temporal_draws, centers$logAnnual))
    age_summary <- summaries$logGradient
    stable <- (age_summary$interval[, 1] > config$gradient_threshold & age > config$gradient_threshold) |
      (age_summary$interval[, 2] < -config$gradient_threshold & age < -config$gradient_threshold)
    stable <- !is.na(stable) & stable & summaries$shift$fraction == 1 & is.finite(summaries$shift$center)
    boundary <- nd$Year == min(years) | nd$Year == max(years)
    for (metric in metrics) {
      summary <- summaries[[metric]]
      hidden <- !is.finite(summary$center)
      reasons <- ifelse(hidden, "NON_FINITE", "")
      if (metric == "shift") {
        hidden <- hidden | !stable
        reasons[!stable] <- ifelse(summary$fraction[!stable] < 1, "NON_FINITE_RATIO", "UNSTABLE_AGE_GRADIENT")
      }
      if (metric == "acceleration") { hidden <- hidden | boundary; reasons[boundary] <- "NATURAL_SPLINE_BOUNDARY" }
      values <- summary$center; lower <- summary$interval[, 1]; upper <- summary$interval[, 2]
      values[hidden] <- lower[hidden] <- upper[hidden] <- NA_real_
      fields[[metric]][ix, 3:11] <- data.frame(values, lower, upper, centers[[metric]], summary$interval[, 1], summary$interval[, 2], hidden, reasons, summary$fraction)
    }
  }
  observations <- data
  observations$ObservedRate <- data$Deaths / data$Pop * 100000
  # Keep the historical cohort coordinate in retained tables, while Figure 4 uses
  # the manuscript's fitted-rate diagnostic on a log horizontal axis.
  observations$Cohort <- data$Year - data$Age_Mid
  observed_grid <- data.frame(Year = data$Year, Age_Mid = data$Age_Mid, Pop = 1)
  observations$FittedRate <- NA_real_
  for (first in seq(1L, nrow(data), by = 128L)) {
    ix <- first:min(nrow(data), first + 127L)
    X_observed <- stats::predict(model, newdata = observed_grid[ix, , drop = FALSE], type = "lpmatrix")
    observations$FittedRate[ix] <- exp(drop(X_observed %*% beta) + log(100000))
  }
  if (any(!is.finite(observations$FittedRate) | observations$FittedRate <= 0))
    stop("Fitted rates are non-finite or nonpositive; the log-scale residual diagnostic cannot be displayed.")
  observations$Residual <- stats::residuals(model, type = "deviance")
  theta <- if (config$distribution == "nb") {
    model$family$getTheta(TRUE)
  } else NULL
  diagnostics <- blsd_basis_diagnostics(model)
  list(input = data, observations = observations, model = model, coefficient_draws = beta_draws, fields = fields,
    diagnostics = diagnostics,
    section_years = section_years, trend_ages = trend_ages,
    metadata = list(sex = sex, distribution = config$distribution, smoothing_requested = config$smoothing,
      smoothing_actual = model$method, theta = theta,
      theta_rule = if (config$distribution != "nb") "NOT_APPLICABLE" else "ESTIMATED_BY_REML",
      scale = model$sig2, scale_rule = if (config$smoothing == "GCV") "ESTIMATED_FOR_GCV" else "FAMILY_REML",
      covariance = covariance_source, seed = config$seed, draws = config$draws, k_age = k_age, k_period = k_period,
      gradient_threshold = config$gradient_threshold, h_age = h_age, h_period = h_period,
      point_estimate = "FITTED_COEFFICIENT_PLUGIN", interval = "APPROXIMATE_95_PERCENT_POINTWISE",
      manuscript_symbols = c(logAnnual = "g_t", logGradient = "g_a", acceleration = "c_t", annual = "A_t", gradient = "A_a", shift = "v"),
      residual_diagnostic = "COUNT_DEVIANCE_RESIDUALS_VS_FITTED_RATE_LOG10",
      R_version = R.version.string, mgcv_version = as.character(utils::packageVersion("mgcv"))))
}

blsd_tile_bounds <- function(frame) {
  edges <- function(x) {
    x <- sort(unique(x)); m <- (head(x, -1L) + tail(x, -1L)) / 2
    c(x[1], m, tail(x, 1))
  }
  years <- sort(unique(frame$Year)); ages <- sort(unique(frame$Age_Mid))
  ye <- edges(years); ae <- edges(ages)
  iy <- match(frame$Year, years); ia <- match(frame$Age_Mid, ages)
  transform(frame, xmin = ye[iy], xmax = ye[iy + 1L], ymin = ae[ia], ymax = ae[ia + 1L])
}

blsd_make_plots <- function(result) {
  # Only retained tables are used below: no fit, prediction or random draws.
  gg <- asNamespace("ggplot2")
  theme <- gg$theme_minimal(base_size = 11) + gg$theme(legend.position = "right",
    panel.grid.major = gg$element_line(colour = "#e7e8eb"),
    panel.grid.minor = gg$element_line(colour = "#eeeeee"), axis.line = gg$element_blank())
  field <- function(metric, legend, kind = "diverging") {
    frame <- blsd_tile_bounds(result$fields[[metric]])
    if (metric == "acceleration") frame <- frame[frame$MaskReason != "NATURAL_SPLINE_BOUNDARY", ]
    p <- gg$ggplot(frame, gg$aes(x = Year, y = Age_Mid)) +
      gg$geom_rect(gg$aes(xmin = xmin, xmax = xmax, ymin = ymin, ymax = ymax, fill = Value), colour = NA) +
      gg$coord_cartesian(expand = FALSE) + gg$labs(x = "Period", y = "Age (years)", fill = legend) + theme
    if (kind == "surface") p <- p + gg$scale_fill_viridis_c(name = legend, na.value = "grey90")
    else if (kind == "sequential") p <- p + gg$scale_fill_gradientn(colours = c("#346D8C", "#F7F5F0", "#CE8D5E"), name = legend, na.value = "grey90")
    else if (metric == "shift") {
      finite <- abs(frame$Value[is.finite(frame$Value)])
      limit <- if (length(finite) && max(finite) > 0) max(finite) else 1
      p <- p + gg$scale_fill_gradient2(low = "#346D8C", mid = "#F7F5F0", high = "#CE8D5E", midpoint = 0,
        limits = c(-limit, limit), name = legend, na.value = "grey90")
    } else p <- p + gg$scale_fill_gradient2(low = "#2166AC", mid = "#FFFFFF", high = "#B2182B",
      midpoint = 0, name = legend, na.value = "grey90")
    p
  }
  # contourLines uses the actual nonuniform coordinates (the prediction grid
  # includes exact observed ages), unlike an index-spaced contour calculation.
  contour_table <- function(metric, bins) {
    frame <- result$fields[[metric]]
    if (!any(is.finite(frame$Value)) || diff(range(frame$Value, na.rm = TRUE)) == 0)
      return(data.frame(Year = numeric(), Age_Mid = numeric(), Path = integer()))
    limits <- range(frame$Value, na.rm = TRUE)
    accuracy <- signif(diff(limits), 1L) / 10
    contour_range <- c(floor(limits[1] / accuracy), ceiling(limits[2] / accuracy)) * accuracy
    levels <- scales::fullseq(contour_range, diff(contour_range) / (bins - 1L))
    if (length(levels) < bins + 1L) levels <- scales::fullseq(contour_range, diff(contour_range) / bins)
    ages <- sort(unique(frame$Age_Mid)); years <- sort(unique(frame$Year))
    z <- matrix(NA_real_, nrow = length(years), ncol = length(ages))
    z[cbind(match(frame$Year, years), match(frame$Age_Mid, ages))] <- frame$Value
    paths <- grDevices::contourLines(years, ages, z, levels = levels)
    if (!length(paths)) return(data.frame(Year = numeric(), Age_Mid = numeric(), Path = integer()))
    do.call(rbind, lapply(seq_along(paths), function(i) data.frame(Year = paths[[i]]$x, Age_Mid = paths[[i]]$y, Path = i)))
  }
  p1 <- field("surface", "ln(rate per 100,000)", "surface") +
    gg$geom_path(data = contour_table("surface", 12L), gg$aes(Year, Age_Mid, group = Path), inherit.aes = FALSE, colour = "white", linewidth = 0.3)
  p2 <- field("annual", "% / year") +
    gg$geom_path(data = contour_table("annual", 10L), gg$aes(Year, Age_Mid, group = Path), inherit.aes = FALSE, colour = "grey30", linewidth = 0.3)
  p3 <- field("acceleration", "Log-rate curvature / year^2")
  obs <- result$observations
  p4 <- gg$ggplot(obs, gg$aes(FittedRate, Residual)) +
    gg$geom_hline(yintercept = 0, colour = "#000000", linetype = "dashed", linewidth = 0.28) +
    gg$geom_point(gg$aes(colour = Age_Mid), alpha = 0.5, size = 1.15, stroke = 0) +
    gg$scale_colour_viridis_c(name = "Age (years)") +
    gg$scale_x_log10(labels = scales::label_number(big.mark = "")) +
    gg$labs(x = "Fitted rate per 100,000", y = "Deviance residual") + theme
  rates <- result$fields$rate
  profiles <- rates[rates$Year %in% result$section_years, ]
  profiles$Period <- factor(profiles$Year, levels = result$section_years)
  observed_profiles <- obs[obs$Year %in% result$section_years & obs$ObservedRate > 0, ]
  observed_profiles$Period <- factor(observed_profiles$Year, levels = result$section_years)
  p5 <- gg$ggplot(profiles, gg$aes(Age_Mid, Value, colour = Period, fill = Period)) +
    gg$geom_ribbon(gg$aes(ymin = Lower, ymax = Upper), alpha = 0.15, colour = NA) + gg$geom_line(linewidth = 0.6) +
    gg$geom_point(data = observed_profiles, gg$aes(y = ObservedRate), size = 1) + gg$scale_y_log10() +
    gg$labs(x = "Age (years)", y = "Rate per 100,000") + theme
  trends <- rates[rates$Age_Mid %in% result$trend_ages, ]
  observed_trends <- obs[obs$Age_Mid %in% result$trend_ages, ]
  trend_labels <- setNames(as.character(result$trend_ages), as.character(result$trend_ages))
  if ("Age_Group" %in% names(obs)) for (age in result$trend_ages) {
    labels <- unique(as.character(obs$Age_Group[obs$Age_Mid == age]))
    labels <- labels[!is.na(labels) & nzchar(trimws(labels))]
    if (length(labels) == 1L) trend_labels[as.character(age)] <- labels
  }
  p6 <- gg$ggplot(trends, gg$aes(Year, Value)) +
    gg$geom_ribbon(gg$aes(ymin = Lower, ymax = Upper), alpha = 0.2, fill = "#2C7FB8") +
    gg$geom_line(colour = "#2166AC", linewidth = 0.6) +
    gg$geom_point(data = observed_trends, gg$aes(y = ObservedRate), size = 1) +
    gg$facet_wrap(~Age_Mid, scales = "free_y", ncol = 3, labeller = gg$as_labeller(trend_labels)) + gg$labs(x = "Period", y = "Rate per 100,000") + theme
  p7a <- field("gradient", "% / age-year", "sequential") + gg$theme(legend.position = "bottom")
  p7b <- field("shift", "Age-years / year") + gg$theme(legend.position = "bottom")
  # Build the combined panel off-screen so Source opens no leading blank page.
  p7 <- (function() {
    previous_device <- grDevices::dev.cur()
    grDevices::pdf(file = NULL)
    device <- grDevices::dev.cur()
    on.exit({
      grDevices::dev.off(device)
      if (previous_device > 1L && previous_device %in% grDevices::dev.list())
        grDevices::dev.set(previous_device)
    }, add = TRUE)
    gridExtra::arrangeGrob(p7a, p7b, ncol = 2)
  })()
  setNames(list(p1, p2, p3, p4, p5, p6, p7), c("surface", "annual_change", "acceleration", "fitted_rate_residuals", "age_profiles", "period_trends", "gradient_and_shift"))
}

blsd_run <- function(config = blsd_config, data = NULL) {
  blsd_require()
  config <- utils::modifyList(blsd_config, config, keep.null = TRUE)
  config$distribution <- match.arg(config$distribution, c("nb", "quasipoisson"))
  config$smoothing <- match.arg(config$smoothing, c("REML", "GCV"))
  valid_number <- function(x, min, integer = FALSE) is.numeric(x) && length(x) == 1L && is.finite(x) && x >= min && (!integer || x == floor(x))
  if (!valid_number(config$draws, 20, TRUE) || !valid_number(config$seed, 0, TRUE) || config$seed > .Machine$integer.max ||
      !valid_number(config$k_age, 4, TRUE) || !valid_number(config$k_period, 4, TRUE) || !valid_number(config$gradient_threshold, 0)) stop("Invalid draws, seed, basis dimension, or gradient threshold.")
  if (config$distribution == "nb" && config$smoothing == "GCV")
    stop("NB + GCV is not supported by this script or the webpage. Use NB + REML, or quasi-Poisson + GCV. No smoothing criterion is silently substituted.")
  if (!is.logical(config$display) || length(config$display) != 1 || is.na(config$display)) stop("display must be TRUE or FALSE.")
  if (!all(config$formats %in% c("pdf", "png")) || !length(config$formats) || !valid_number(config$dpi, 72, TRUE)) stop("formats must contain pdf/png and dpi must be >=72.")
  supplied_data <- !is.null(data)
  if (is.null(data)) data <- if (is.null(config$input_csv)) blsd_example_data() else
    utils::read.csv(config$input_csv, stringsAsFactors = FALSE, check.names = FALSE, fileEncoding = "UTF-8-BOM")
  source_input <- data
  data <- blsd_validate_input(data)
  groups <- if ("Sex" %in% names(data)) unique(data$Sex) else NA_character_
  if (!is.null(config$selected_sexes)) {
    if (!"Sex" %in% names(data) || any(!config$selected_sexes %in% groups) || !length(config$selected_sexes)) stop("selected_sexes must name existing groups in the input.")
    groups <- unique(config$selected_sexes)
  }
  results <- vector("list", length(groups))
  for (i in seq_along(groups)) {
    sex <- if (is.na(groups[i])) NULL else groups[i]
    group_data <- if (is.null(sex)) data else data[data$Sex == sex, , drop = FALSE]
    message("Fitting ", config$distribution, " + ", config$smoothing, if (!is.null(sex)) paste0(" [", sex, "]") else "")
    result <- blsd_fit_one(group_data, config, sex)
    message("Basis-dimension diagnostic: ", result$diagnostics$basis_check_status,
      " (", result$diagnostics$replicates, " permutations; independent seed ", result$diagnostics$seed, ")")
    print(result$diagnostics$basis_checks, row.names = FALSE)
    if (!is.null(result$diagnostics$error)) message("Basis check unavailable: ", result$diagnostics$error)
    if (length(result$diagnostics$warnings)) message(paste(result$diagnostics$warnings, collapse = "\n"))
    result$plots <- blsd_make_plots(result)
    if (config$display) for (plot in result$plots) {
      if (inherits(plot, "ggplot")) print(plot) else { grid::grid.newpage(); grid::grid.draw(plot) }
    }
    if (!is.null(config$output_dir)) {
      safe_group <- if (is.null(sex)) "ungrouped" else gsub("[^A-Za-z0-9_-]", "_", sex)
      destination <- file.path(config$output_dir, sprintf("%02d_%s", i, safe_group))
      dir.create(destination, recursive = TRUE, showWarnings = FALSE)
      for (j in seq_along(result$plots)) for (format in unique(config$formats))
        ggplot2::ggsave(file.path(destination, sprintf("Figure%d_%s.%s", j, names(result$plots)[j], format)),
          plot = result$plots[[j]], width = if (j == 7L) 11 else 7.09, height = if (j == 6L) 5.5 else 4.6,
          units = "in", dpi = config$dpi, bg = "white", limitsize = TRUE)
    }
    results[[i]] <- result
  }
  names(results) <- ifelse(is.na(groups), "ungrouped", groups)
  invisible(list(groups = results, config = config, source_input = source_input,
    example = !supplied_data && is.null(config$input_csv),
    example_sha256 = if (!supplied_data && is.null(config$input_csv)) "5d2b2edac8329cedf6b2fecb29fbb046b62b892dfba27255c9d4541575a0f46c" else NULL))
}

if (!isTRUE(getOption("blsd.skip_autorun", FALSE))) blsd_result <- blsd_run(blsd_config)
