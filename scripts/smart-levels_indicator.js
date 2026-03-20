//@version=6
indicator("Ultra Scalper: Smart Labels + Momentum Engine [v6.0]", overlay = true, max_lines_count = 500, max_labels_count = 500)

// =============================================================================
// EMA ID GUIDE FOR ALERT MESSAGE DECODING
// =============================================================================
// | ID | EMA NAME      | 5-MIN CANDLES |
// |----|---------------|---------------|
// | 0  | 9 EMA (5m)    | 9             |
// | 1  | 26 EMA (5m)   | 26            |
// | 2  | 50 EMA (5m)   | 50            |
// | 3  | 200 EMA (5m)  | 200           |
// | 4  | 9 EMA (30m)   | 54            |
// | 5  | 26 EMA (30m)  | 156           |
// | 6  | 50 EMA (30m)  | 300           |
// | 7  | 200 EMA (30m) | 1200          |
// | 8  | 9 EMA (1h)    | 108           |
// | 9  | 26 EMA (1h)   | 312           |
// | 10 | 50 EMA (1h)   | 600           |
// | 11 | 200 EMA (1h)  | 2400          |
// | 12 | 9 EMA (4h)    | 432           |
// | 13 | 26 EMA (4h)   | 1248          |
// | 14 | 50 EMA (4h)   | 2400          |
// | 15 | 200 EMA (4h)  | 9600          |
// =============================================================================

// =============================================================================
// 1. INPUTS
// =============================================================================
grp_vis = "1. Visibility & Toggles"
show_D = input.bool(true, "Show Daily", group = grp_vis)
show_W = input.bool(true, "Show Weekly", group = grp_vis)
show_M = input.bool(true, "Show Monthly", group = grp_vis)
show_Logic = input.bool(true, "Show Logic Points", group = grp_vis)
show_EMAs = input.bool(true, "Show 5m EMAs", group = grp_vis)
show_200EMAs = input.bool(true, "Show 200 EMAs (All TFs)", group = grp_vis)
show_Fibs = input.bool(true, "Show Fibonacci Levels", group = grp_vis)
show_MegaSpots = input.bool(true, "Show Mega Spots", group = grp_vis)
show_all = input.bool(false, "Show All Levels (Ignore Star Filter)", group = grp_vis)

grp_col = "2. Colors"
c_open = input.color(color.blue, "Open", group = grp_col)
c_high = input.color(color.green, "High", group = grp_col)
c_low = input.color(color.orange, "Low", group = grp_col)
c_close = input.color(color.red, "Close", group = grp_col)
c_ema_fast = input.color(color.yellow, "EMAs Fast (9,26)", group = grp_col)
c_ema_slow = input.color(color.purple, "EMAs Slow (50,200)", group = grp_col)
c_ema_200 = input.color(color.fuchsia, "200 EMAs", group = grp_col)
c_mega = input.color(color.white, "Mega Spots", group = grp_col)
c_fib = input.color(color.aqua, "Fibonacci", group = grp_col)

grp_wid = "3. Lines & Lengths"
w_m = input.int(4, "Monthly Width", minval = 1, group = grp_wid)
w_w = input.int(3, "Weekly Width", minval = 1, group = grp_wid)
w_d = input.int(2, "Daily Width", minval = 1, group = grp_wid)
w_1h = input.int(1, "1H Width", minval = 1, group = grp_wid)
w_4h = input.int(1, "4H Width", minval = 1, group = grp_wid)
line_offset = input.int(10, "Line Start Offset", group = grp_wid)
line_length_base = input.int(50, "Base Line Length", minval = 20, maxval = 100, group = grp_wid)
line_length_min = input.int(30, "Min Line Length", minval = 10, maxval = 50, group = grp_wid)
line_length_max = input.int(80, "Max Line Length", minval = 50, maxval = 150, group = grp_wid)
base_label_size = input.string("Small", "Base Label Size", options = ["Tiny", "Small", "Normal", "Large", "Huge"], group = grp_wid)
label_padding = input.int(5, "Label Horizontal Padding", minval = 0, maxval = 50, group = grp_wid)

grp_perf = "4. Performance & Filters"
conf_proximity = input.float(5.0, "Confluence Pre-filter %", minval = 1.0, maxval = 10.0, step = 0.5, group = grp_perf)
draw_proximity = input.float(10.0, "Draw Proximity Zone %", minval = 5.0, maxval = 20.0, step = 1.0, group = grp_perf)
max_conf_checks = input.int(15, "Max Confluence Checks", minval = 10, maxval = 25, group = grp_perf)
min_stars = input.int(1, "Min Stars to Draw (0=all)", minval = 0, maxval = 5, group = grp_perf)

grp_fib = "5. Fibonacci Settings"
fib_lookback = input.int(50, "5m Fib Lookback Bars", minval = 20, maxval = 100, group = grp_fib)

grp_mega = "6. Mega Spot Settings"
mega_cluster_threshold = input.float(0.25, "Mega Cluster Threshold %", minval = 0.1, maxval = 0.5, step = 0.05, group = grp_mega)


grp_mom_rsi = "7. Momentum & RSI Engine"
use_atr_threshold = input.bool(true, "Use ATR for Dynamic Threshold", group = grp_mom_rsi)
atr_len_mom = input.int(14, "ATR Length (Mom)", group = grp_mom_rsi)
atr_mult = input.float(2.0, "ATR Multiplier", step = 0.25, group = grp_mom_rsi)
fast_move_pct = input.float(1.5, "Fallback Static Threshold (%)", minval = 0.1, step = 0.1, group = grp_mom_rsi)
lookback = input.int(14, "Momentum Lookback", minval = 1, group = grp_mom_rsi)
rsiLength = input.int(14, "RSI Length", group = grp_mom_rsi)
use_vol_conf = input.bool(true, "Use Volume Confirmation", group = grp_mom_rsi)
vol_len = input.int(20, "Volume Average Length", group = grp_mom_rsi)
volume_factor = input.float(1.75, "Volume Spike Factor", group = grp_mom_rsi)
us_roc_trigger_thresh = input.float(1.0, "Alert Trigger ROC Threshold (±)", step = 0.1, group = grp_mom_rsi)

// =============================================================================
// 2. CORE CALCULATIONS (Current Timeframe)
// =============================================================================
var atr_val = ta.atr(14)

// 5-Minute EMAs (Native)
float ema_9_raw = ta.ema(close, 9)
float ema_26_raw = ta.ema(close, 26)
float ema_50_raw = ta.ema(close, 50)
float ema_200_raw = ta.ema(close, 200)

ema_9 = show_EMAs ? ema_9_raw : na
ema_26 = show_EMAs ? ema_26_raw : na
ema_50 = show_EMAs ? ema_50_raw : na
ema_200_5m = show_200EMAs ? ema_200_raw : na

// 5-Minute Fibonacci
swing_high_5m = show_Fibs ? ta.highest(high, fib_lookback) : na
swing_low_5m = show_Fibs ? ta.lowest(low, fib_lookback) : na
fib_5m_50 = show_Fibs and not na(swing_high_5m) and not na(swing_low_5m) ? swing_low_5m + (swing_high_5m - swing_low_5m) * 0.5 : na
fib_5m_618 = show_Fibs and not na(swing_high_5m) and not na(swing_low_5m) ? swing_low_5m + (swing_high_5m - swing_low_5m) * 0.618 : na

// =============================================================================
// 3. HTF DATA REQUESTS
// =============================================================================
[mo_r, mh_r, ml_r, mc_r] = request.security(syminfo.tickerid, "M", [open[1], high[1], low[1], close[1]], lookahead = barmerge.lookahead_on)
[wo_r, wh_r, wl_r, wc_r] = request.security(syminfo.tickerid, "W", [open[1], high[1], low[1], close[1]], lookahead = barmerge.lookahead_on)
[do_r, dh_r, dl_r, dc_r, do1, dh1, dl1, dc1, do2, dh2, dl2, dc2, ema_200_15m_r] = request.security(syminfo.tickerid, "D", [open[1], high[1], low[1], close[1], open[1], high[1], low[1], close[1], open[2], high[2], low[2], close[2], ta.ema(close, 200)], lookahead = barmerge.lookahead_on)
[h4o1, h4h1, h4l1, h4c1, h4o2, h4h2, h4l2, h4c2, ema_200_4h_r] = request.security(syminfo.tickerid, "240", [open[1], high[1], low[1], close[1], open[2], high[2], low[2], close[2], ta.ema(close, 200)], lookahead = barmerge.lookahead_on)
[h1h, h1l, h1o1, h1h1, h1l1, h1c1, h1o2, h1h2, h1l2, h1c2, ema_200_1h_r, wh_fib, wl_fib] = request.security(syminfo.tickerid, "60", [high[1], low[1], open[1], high[1], low[1], close[1], open[2], high[2], low[2], close[2], ta.ema(close, 200), request.security(syminfo.tickerid, "W", high[1], lookahead = barmerge.lookahead_on), request.security(syminfo.tickerid, "W", low[1], lookahead = barmerge.lookahead_on)], lookahead = barmerge.lookahead_on)

// New Engine HTF Requests
[e30_9, e30_26, e30_50, e30_200, rsi_30] = request.security(syminfo.tickerid, "30", [ta.ema(close, 9), ta.ema(close, 26), ta.ema(close, 50), ta.ema(close, 200), ta.rsi(close, rsiLength)], lookahead = barmerge.lookahead_on)
[e60_9, e60_26, e60_50, rsi_60] = request.security(syminfo.tickerid, "60", [ta.ema(close, 9), ta.ema(close, 26), ta.ema(close, 50), ta.rsi(close, rsiLength)], lookahead = barmerge.lookahead_on)
[e240_9, e240_26, e240_50, rsi_240] = request.security(syminfo.tickerid, "240", [ta.ema(close, 9), ta.ema(close, 26), ta.ema(close, 50), ta.rsi(close, rsiLength)], lookahead = barmerge.lookahead_on)
rsi_5 = ta.rsi(close, rsiLength)

// 24H Day Change & Volume Requests for Webhook Sync
[d_vol, d_open_current] = request.security(syminfo.tickerid, "D", [volume, open], lookahead = barmerge.lookahead_on)
float day_change_pct = na(d_open_current) or d_open_current == 0 ? 0.0 : ((close - d_open_current) / d_open_current) * 100.0

// Conditional Assignments
m_o = show_M ? mo_r : na
m_h = show_M ? mh_r : na
m_l = show_M ? ml_r : na
m_c = show_M ? mc_r : na
w_o = show_W ? wo_r : na
w_h = show_W ? wh_r : na
w_l = show_W ? wl_r : na
w_c = show_W ? wc_r : na
d_o = show_D ? do_r : na
d_h = show_D ? dh_r : na
d_l = show_D ? dl_r : na
d_c = show_D ? dc_r : na
ema_200_15m = show_200EMAs ? ema_200_15m_r : na
ema_200_1h = show_200EMAs ? ema_200_1h_r : na
ema_200_4h = show_200EMAs ? ema_200_4h_r : na

// =============================================================================
// 4. FIBONACCI & LOGIC POINT CALCULATIONS
// =============================================================================
fib_1h_50 = show_Fibs and not na(h1h) and not na(h1l) ? h1l + (h1h - h1l) * 0.5 : na
fib_1h_618 = show_Fibs and not na(h1h) and not na(h1l) ? h1l + (h1h - h1l) * 0.618 : na
fib_d_50 = show_Fibs and not na(dh_r) and not na(dl_r) ? dl_r + (dh_r - dl_r) * 0.5 : na
fib_d_618 = show_Fibs and not na(dh_r) and not na(dl_r) ? dl_r + (dh_r - dl_r) * 0.618 : na
fib_w_50 = show_Fibs and not na(wh_fib) and not na(wl_fib) ? wl_fib + (wh_fib - wl_fib) * 0.5 : na
fib_w_618 = show_Fibs and not na(wh_fib) and not na(wl_fib) ? wl_fib + (wh_fib - wl_fib) * 0.618 : na

valid_d = show_Logic and not na(do1) and not na(do2)
d_bb = valid_d and((math.abs(dc2 - do1) < do1 * 0.001) or(math.abs(dl2 - dl1) < do1 * 0.001)) ? math.min(dl1, dl2) : na
d_brb = valid_d and((math.abs(dc2 - do1) < do1 * 0.001) or(math.abs(dh2 - dh1) < do1 * 0.001)) ? math.max(dh1, dh2) : na
d_bn = valid_d and dc2 < do2 and dc1 > do1 and dc1 > do2 and do1 < dc2 ? dh2 : na
d_brn = valid_d and dc2 > do2 and dc1 < do1 and dc1 < dl2 and do1 > dh2 ? dl2 : na

valid_1h = show_Logic and not na(h1o1) and not na(h1o2)
h1_bb = valid_1h and((math.abs(h1c2 - h1o1) < h1o1 * 0.001) or(math.abs(h1l2 - h1l1) < h1o1 * 0.001)) ? math.min(h1l1, h1l2) : na
h1_brb = valid_1h and((math.abs(h1c2 - h1o1) < h1o1 * 0.001) or(math.abs(h1h2 - h1h1) < h1o1 * 0.001)) ? math.max(h1h1, h1h2) : na
h1_bn = valid_1h and h1c2 < h1o2 and h1c1 > h1o1 and h1c1 > h1o2 and h1o1 < h1c2 ? h1h2 : na
h1_brn = valid_1h and h1c2 > h1o2 and h1c1 < h1o1 and h1c1 < h1l2 and h1o1 > h1h2 ? h1l2 : na

valid_4h = show_Logic and not na(h4o1) and not na(h4o2)
h4_bn = valid_4h and h4c2 < h4o2 and h4c1 > h4o1 and h4c1 > h4o2 and h4o1 < h4c2 ? h4h2 : na
h4_brn = valid_4h and h4c2 > h4o2 and h4c1 < h4o1 and h4c1 < h4l2 and h4o1 > h4h2 ? h4l2 : na

// =============================================================================
// 5. MOMENTUM, RSI, AND EMA ID CALCULATIONS (NEW ENGINE)
// =============================================================================
// Momentum & Volume
float m_roc_val = ta.roc(close, lookback)
float m_atr_val = ta.atr(atr_len_mom)
float m_avg_vol = ta.ema(volume, vol_len)
bool is_m_spike = volume > (m_avg_vol * volume_factor)

float dynamic_threshold_pct = (m_atr_val * atr_mult / close) * 100
float threshold_pct = use_atr_threshold ? dynamic_threshold_pct : fast_move_pct

bool is_fast_up = m_roc_val > threshold_pct
bool is_fast_down = m_roc_val < -threshold_pct
bool confirmed_up = is_fast_up and(not use_vol_conf or is_m_spike)
bool confirmed_down = is_fast_down and(not use_vol_conf or is_m_spike)

// Exact Directional & Signal Logic
int dir_signal = confirmed_up ? 1 : (confirmed_down ? -2 : 0)
float roc_on_signal = (confirmed_up or confirmed_down) ?m_roc_val: na

// EMA ID Tracking & Next Support/Resistance
var int support_ema_name_id = -1
var int resistance_ema_name_id = -1
var float next_support_val = na
var float next_resistance_val = na

if barstate.islast
    float[] id_emas = array.from(ema_9_raw, ema_26_raw, ema_50_raw, ema_200_raw, e30_9, e30_26, e30_50, e30_200, e60_9, e60_26, e60_50, ema_200_1h_r, e240_9, e240_26, e240_50, ema_200_4h_r)
    float s_val = 0.0
    float r_val = 9999999.9
    int s_id = -1
    int r_id = -1

for i = 0 to 15
        float e = array.get(id_emas, i)
if not na(e)
if e < close and e > s_val
s_val:= e
s_id:= i
if e > close and e < r_val
r_val:= e
r_id:= i

support_ema_name_id:= s_id
resistance_ema_name_id:= r_id
next_support_val:= s_val
next_resistance_val:= r_val

// =============================================================================
// 6. MEGA SPOT DETECTION (OPTIMIZED)
// =============================================================================
var float[] mega_spot_prices = array.new < float > (0)
var int[] mega_spot_counts = array.new < int > (0)

if barstate.islast and show_MegaSpots
array.clear(mega_spot_prices)
array.clear(mega_spot_counts)
    
    bool all_emas_valid = not na(ema_200_5m) and not na(ema_200_15m) and not na(ema_200_1h) and not na(ema_200_4h) and ema_200_5m > 0
if all_emas_valid
        float e5m = ema_200_5m, float e15m = ema_200_15m, float e1h = ema_200_1h, float e4h = ema_200_4h
        float dist_5m_15m = math.abs((e5m - e15m) / e5m * 100)
        float dist_5m_1h = math.abs((e5m - e1h) / e5m * 100)
        float dist_5m_4h = math.abs((e5m - e4h) / e5m * 100)
        float dist_15m_1h = math.abs((e15m - e1h) / e15m * 100)
        float dist_15m_4h = math.abs((e15m - e4h) / e15m * 100)
        float dist_1h_4h = math.abs((e1h - e4h) / e1h * 100)
        
        bool c_5m_15m = dist_5m_15m <= mega_cluster_threshold, bool c_5m_1h = dist_5m_1h <= mega_cluster_threshold
        bool c_5m_4h = dist_5m_4h <= mega_cluster_threshold, bool c_15m_1h = dist_15m_1h <= mega_cluster_threshold
        bool c_15m_4h = dist_15m_4h <= mega_cluster_threshold, bool c_1h_4h = dist_1h_4h <= mega_cluster_threshold
        
        bool used_5m = false, bool used_15m = false, bool used_1h = false, bool used_4h = false

if c_5m_15m and c_5m_1h and c_5m_4h and c_15m_1h and c_15m_4h and c_1h_4h
array.push(mega_spot_prices, (e5m + e15m + e1h + e4h) / 4), array.push(mega_spot_counts, 4)
used_5m:= true, used_15m := true, used_1h := true, used_4h := true

if not used_5m and not used_15m and not used_1h and c_5m_15m and c_5m_1h and c_15m_1h
array.push(mega_spot_prices, (e5m + e15m + e1h) / 3), array.push(mega_spot_counts, 3)
used_5m:= true, used_15m := true, used_1h := true

if not used_5m and not used_15m and not used_4h and c_5m_15m and c_5m_4h and c_15m_4h
array.push(mega_spot_prices, (e5m + e15m + e4h) / 3), array.push(mega_spot_counts, 3)
used_5m:= true, used_15m := true, used_4h := true

if not used_5m and not used_1h and not used_4h and c_5m_1h and c_5m_4h and c_1h_4h
array.push(mega_spot_prices, (e5m + e1h + e4h) / 3), array.push(mega_spot_counts, 3)
used_5m:= true, used_1h := true, used_4h := true

if not used_15m and not used_1h and not used_4h and c_15m_1h and c_15m_4h and c_1h_4h
array.push(mega_spot_prices, (e15m + e1h + e4h) / 3), array.push(mega_spot_counts, 3)
used_15m:= true, used_1h := true, used_4h := true

if not used_5m and not used_15m and c_5m_15m
array.push(mega_spot_prices, (e5m + e15m) / 2), array.push(mega_spot_counts, 2), used_5m := true, used_15m := true
if not used_5m and not used_1h and c_5m_1h
array.push(mega_spot_prices, (e5m + e1h) / 2), array.push(mega_spot_counts, 2), used_5m := true, used_1h := true
if not used_5m and not used_4h and c_5m_4h
array.push(mega_spot_prices, (e5m + e4h) / 2), array.push(mega_spot_counts, 2), used_5m := true, used_4h := true
if not used_15m and not used_1h and c_15m_1h
array.push(mega_spot_prices, (e15m + e1h) / 2), array.push(mega_spot_counts, 2), used_15m := true, used_1h := true
if not used_15m and not used_4h and c_15m_4h
array.push(mega_spot_prices, (e15m + e4h) / 2), array.push(mega_spot_counts, 2), used_15m := true, used_4h := true
if not used_1h and not used_4h and c_1h_4h
array.push(mega_spot_prices, (e1h + e4h) / 2), array.push(mega_spot_counts, 2), used_1h := true, used_4h := true

// =============================================================================
// 7. OPTIMIZED CONFLUENCE ENGINE WITH ANTI-CLUTTER
// =============================================================================
var line[] lines = array.new < line > ()
var label[] labels = array.new < label > ()
var float[] check_arr = array.new < float > ()
var float[] drawn_levels = array.new < float > ()
var int[] drawn_lengths = array.new < int > ()

f_build_check_arr() =>
array.clear(check_arr)
if not na(ema_9)
array.push(check_arr, ema_9)
if not na(ema_26)
array.push(check_arr, ema_26)
if not na(ema_50)
array.push(check_arr, ema_50)
if not na(ema_200_5m)
array.push(check_arr, ema_200_5m)
if not na(ema_200_15m)
array.push(check_arr, ema_200_15m)
if not na(ema_200_1h)
array.push(check_arr, ema_200_1h)
if not na(ema_200_4h)
array.push(check_arr, ema_200_4h)
if not na(fib_5m_50)
array.push(check_arr, fib_5m_50)
if not na(fib_5m_618)
array.push(check_arr, fib_5m_618)
if not na(fib_1h_50)
array.push(check_arr, fib_1h_50)
if not na(fib_1h_618)
array.push(check_arr, fib_1h_618)
if not na(fib_d_50)
array.push(check_arr, fib_d_50)
if not na(fib_d_618)
array.push(check_arr, fib_d_618)
if not na(fib_w_50)
array.push(check_arr, fib_w_50)
if not na(fib_w_618)
array.push(check_arr, fib_w_618)

f_conf(float p) =>
    int s = 0
if not na(p) and not na(atr_val) and p > 0
        float tol = atr_val * 0.1
        float prox_filter = p * (conf_proximity / 100.0)
        int sz = array.size(check_arr)
        int checked = 0
for i = 0 to sz - 1
            if checked >= max_conf_checks
                break
            float v = array.get(check_arr, i)
if not na(v)
                float d = math.abs(v - p)
if d > prox_filter
                    continue
checked += 1
if d < tol and d > 0.00001
s += 1
if s >= 5
                        break
s

f_get_staggered_length(float p, int base_length, bool is_mega, bool is_htf) =>
    int final_length = base_length
    bool too_close = false
    int stagger_offset = 0
if not na(p) and close > 0
        float min_spacing_pct = 0.15 
        int sz = array.size(drawn_levels)
if sz > 0
            for i = 0 to math.min(sz - 1, 50) 
                float existing_price = array.get(drawn_levels, i)
                float dist_pct = math.abs((existing_price - p) / close * 100)
if dist_pct < min_spacing_pct
                    too_close:= true
stagger_offset:= (i % 3) * 10
break
if too_close
        int pattern = stagger_offset / 10
if pattern == 0
            final_length:= base_length - 15
else if pattern == 1
            final_length:= base_length
else
    final_length:= base_length + 15
if is_mega or is_htf
final_length += 10
    else
final_length:= base_length
math.max(line_length_min, math.min(line_length_max, final_length))

f_get_line_length(int stars, bool is_mega, bool is_htf) =>
    int length = line_length_base
if is_mega
        length:= line_length_max
else
    if stars >= 5
            length += 20
    else if stars == 4
            length += 15
    else if stars == 3
            length += 10
    else if stars == 2
            length += 5
if is_htf
            length += 10
math.max(line_length_min, math.min(line_length_max, length))

f_get_label_size(int stars, bool is_mega, bool is_htf) =>
    string b = base_label_size == "Tiny" ? size.tiny : base_label_size == "Small" ? size.small : base_label_size == "Normal" ? size.normal : base_label_size == "Large" ? size.large : size.huge
    string final_size = b
if is_mega
        final_size:= (b == size.tiny ? size.normal : b == size.small ? size.large : size.huge)
else if stars >= 4 or is_htf
final_size:= (b == size.tiny ? size.small : b == size.small ? size.normal : size.large)
final_size

f_should_skip(float p, int stars, bool is_mega, bool is_htf) =>
    bool skip = false
if is_mega or stars >= 4 or is_htf
skip:= false
    else if not na(p) and close > 0
        float very_close_pct = 0.08
        int sz = array.size(drawn_levels)
if sz > 10
            for i = 0 to math.min(sz - 1, 30)
                float existing = array.get(drawn_levels, i)
                float dist_pct = math.abs((existing - p) / close * 100)
if dist_pct < very_close_pct and stars < 2
skip:= true
break
skip

f_draw(float p, string n, color c, int w, bool is_solid, bool is_htf, bool is_mega) =>
if not na(p) and p > 0
        int sc = f_conf(p)
        bool should_draw = show_all
if not should_draw
if sc >= min_stars
                should_draw:= true
else if is_mega
                should_draw:= true
else
                float dist_pct = math.abs(p - close) / close * 100.0
if dist_pct <= draw_proximity
                    should_draw:= true
if should_draw and not show_all
            bool skip = f_should_skip(p, sc, is_mega, is_htf)
if skip
                should_draw:= false
if should_draw
            string star = sc >= 5 ? "★★★★★" : sc == 4 ? "★★★★" : sc == 3 ? "★★★" : sc == 2 ? "★★" : sc == 1 ? "★" : ""
            string txt = n + (star != "" ? " " + star : "")
            int base_length = f_get_line_length(sc, is_mega, is_htf)
            int final_length = f_get_staggered_length(p, base_length, is_mega, is_htf)
            int x1 = bar_index + line_offset
            int x2 = x1 + final_length
            string label_size = f_get_label_size(sc, is_mega, is_htf)
            color col_trans = color.new(c, 20)
            string sty = is_solid ? line.style_solid : line.style_dashed
            line l = line.new(x1, p, x2, p, color = col_trans, width = w, style = sty)
            label lb = label.new(x2 + label_padding, p, txt, color = color.new(color.black, 100), style = label.style_label_left, textcolor = c, size = label_size)
array.push(lines, l)
array.push(labels, lb)
array.push(drawn_levels, p)
array.push(drawn_lengths, final_length)

// =============================================================================
// 8. PRIORITY-BASED DRAWING LOGIC
// =============================================================================
if barstate.islast
    f_build_check_arr()
    int lsz = array.size(lines)
if lsz > 0
        for i = 0 to math.min(lsz - 1, 100)
            line.delete(array.get(lines, i))
array.clear(lines)
    int bsz = array.size(labels)
if bsz > 0
        for i = 0 to math.min(bsz - 1, 100)
            label.delete(array.get(labels, i))
array.clear(labels)
array.clear(drawn_levels)
array.clear(drawn_lengths)

f_draw(fib_5m_50, "5m.Fib50", c_fib, 1, false, false, false)
f_draw(fib_5m_618, "5m.Fib618", c_fib, 1, false, false, false)
f_draw(fib_1h_50, "1H.Fib50", c_fib, 1, false, false, false)
f_draw(fib_1h_618, "1H.Fib618", c_fib, 1, false, false, false)
f_draw(fib_d_50, "D.Fib50", c_fib, 1, false, false, false)
f_draw(fib_d_618, "D.Fib618", c_fib, 1, false, false, false)
f_draw(fib_w_50, "W.Fib50", c_fib, 2, false, true, false)
f_draw(fib_w_618, "W.Fib618", c_fib, 2, false, true, false)

f_draw(ema_9, "5m.9", c_ema_fast, 1, true, false, false)
f_draw(ema_26, "5m.26", c_ema_fast, 1, true, false, false)
f_draw(ema_50, "5m.50", c_ema_slow, 2, true, false, false)

f_draw(h4_bn, "4H.Neck", c_low, w_4h, false, false, false)
f_draw(h4_brn, "4H.Neck", c_high, w_4h, false, false, false)
f_draw(h1_bb, "1H.Base", c_low, w_1h, false, false, false)
f_draw(h1_brb, "1H.Base", c_high, w_1h, false, false, false)
f_draw(h1_bn, "1H.Neck", c_low, w_1h, false, false, false)
f_draw(h1_brn, "1H.Neck", c_high, w_1h, false, false, false)
f_draw(d_bb, "D.Base", c_low, w_d, false, true, false)
f_draw(d_brb, "D.Base", c_high, w_d, false, true, false)
f_draw(d_bn, "D.Neck", c_low, w_d, false, true, false)
f_draw(d_brn, "D.Neck", c_high, w_d, false, true, false)

f_draw(ema_200_5m, "5m.200", c_ema_200, 2, true, false, false)
f_draw(ema_200_15m, "15m.200", c_ema_200, 2, true, false, false)
f_draw(ema_200_1h, "1H.200", c_ema_200, 2, true, true, false)
f_draw(ema_200_4h, "4H.200", c_ema_200, 3, true, true, false)

f_draw(d_o, "DO", c_open, w_d, true, true, false)
f_draw(d_h, "DH", c_high, w_d, false, true, false)
f_draw(d_l, "DL", c_low, w_d, false, true, false)
f_draw(d_c, "DC", c_close, w_d, true, true, false)

f_draw(w_o, "WO", c_open, w_w, true, true, false)
f_draw(w_h, "WH", c_high, w_w, false, true, false)
f_draw(w_l, "WL", c_low, w_w, false, true, false)
f_draw(w_c, "WC", c_close, w_w, true, true, false)

f_draw(m_o, "MO", c_open, w_m, true, true, false)
f_draw(m_h, "MH", c_high, w_m, false, true, false)
f_draw(m_l, "ML", c_low, w_m, false, true, false)
f_draw(m_c, "MC", c_close, w_m, true, true, false)
    
    int num_mega = array.size(mega_spot_prices)
if num_mega > 0
        for i = 0 to num_mega - 1
            float mega_price = array.get(mega_spot_prices, i)
            int mega_count = array.get(mega_spot_counts, i)
            string mega_name = "⚡MEGA[" + str.tostring(mega_count) + "]"
f_draw(mega_price, mega_name, c_mega, 3, true, true, true)

// =============================================================================
// 9. NATIVE JSON BUILDER (NOW WITH STAR RATINGS)
// =============================================================================
// Upgraded helper: Exports {"p": "price", "s": stars} instead of just "price"
f_json_level(float p) =>
    bool was_drawn = false
if array.size(drawn_levels) > 0 and not na(p)
for i = 0 to array.size(drawn_levels) - 1
            if array.get(drawn_levels, i) == p
                was_drawn:= true
break
// If drawn, calculate stars and build object. If not, return standard null.
was_drawn ? '{"p": "' + str.tostring(math.round(p, 2)) + '", "s": ' + str.tostring(f_conf(p)) + '}' : 'null'

f_json_num(float p) =>
na(p) ? 'null' : '"' + str.tostring(p) + '"'

var float nearest_mega_alert = na
var int nearest_mega_count = 0
if barstate.islast and show_MegaSpots and array.size(mega_spot_prices) > 0
    float min_dist = 999999.0
for i = 0 to array.size(mega_spot_prices) - 1
        float m_price = array.get(mega_spot_prices, i)
if math.abs(m_price - close) < min_dist
            min_dist:= math.abs(m_price - close)
nearest_mega_alert:= m_price
nearest_mega_count:= array.get(mega_spot_counts, i) // Grab the Mega cluster count!

// =============================================================================
// 10. TRIGGER LOGIC & WEBHOOK FIRING (THE "GOD MODE" PAYLOAD)
// =============================================================================
bool custom_trigger = (confirmed_up or confirmed_down) and math.abs(m_roc_val) > us_roc_trigger_thresh


// Flashes the background yellow when the webhook fires
// bgcolor(custom_trigger ? color.new(color.yellow, 80) : na, title="Alert Trigger Flash")

if custom_trigger
    // 🛑 CRITICAL FIX: Re-build the check array so star calculations are 100% accurate for this exact tick
    f_build_check_arr() 

    string t_ticker = syminfo.ticker
    string t_time = str.tostring(time)

string[] j = array.new_string()

// --- CORE & TIME ---
array.push(j, '{')
array.push(j, '"ticker": "' + t_ticker + '",')
array.push(j, '"timestamp": ' + t_time + ',')
array.push(j, '"price": ' + f_json_num(math.round(close, 2)) + ',')

// --- MOMENTUM ---
array.push(j, '"momentum": {')
array.push(j, '"direction": ' + f_json_num(dir_signal) + ',')
array.push(j, '"roc_pct": ' + f_json_num(math.round(m_roc_val, 2)) + ',')
array.push(j, '"trigger_roc": ' + f_json_num(math.round(roc_on_signal, 2)) + ',')
array.push(j, '"day_change_pct": ' + f_json_num(math.round(day_change_pct, 2)))
array.push(j, '},')

// --- VOLUME ---
array.push(j, '"volume": {')
array.push(j, '"day_vol": ' + f_json_num(math.round(d_vol)) + ',')
array.push(j, '"vol_spike": ' + (is_m_spike ? '1' : '0'))
array.push(j, '},')

// --- RSIs ---
array.push(j, '"rsi_matrix": {')
array.push(j, '"m5": ' + f_json_num(math.round(rsi_5, 2)) + ',')
array.push(j, '"m30": ' + f_json_num(math.round(rsi_30, 2)) + ',')
array.push(j, '"h1": ' + f_json_num(math.round(rsi_60, 2)) + ',')
array.push(j, '"h4": ' + f_json_num(math.round(rsi_240, 2)))
array.push(j, '},')

// --- EMA IDs ---
array.push(j, '"ema_id_zones": {')
array.push(j, '"support_id": ' + f_json_num(support_ema_name_id) + ',')
array.push(j, '"resistance_id": ' + f_json_num(resistance_ema_name_id))
array.push(j, '},')

// --- SMART LEVELS (NOW WITH STARS!) ---
array.push(j, '"smart_levels": {')

// Mega spot gets a special object: "p" for price, "c" for cluster count
if not na(nearest_mega_alert)
array.push(j, '"mega_spot": {"p": "' + str.tostring(math.round(nearest_mega_alert, 2)) + '", "c": ' + str.tostring(nearest_mega_count) + '},')
    else
array.push(j, '"mega_spot": null,')

array.push(j, '"emas_200": {')
array.push(j, '"m5": ' + f_json_level(ema_200_5m) + ',')
array.push(j, '"m15": ' + f_json_level(ema_200_15m) + ',')
array.push(j, '"h1": ' + f_json_level(ema_200_1h) + ',')
array.push(j, '"h4": ' + f_json_level(ema_200_4h))
array.push(j, '},')

array.push(j, '"daily_logic": {')
array.push(j, '"base_supp": ' + f_json_level(d_bb) + ',')
array.push(j, '"base_res": ' + f_json_level(d_brb) + ',')
array.push(j, '"neck_supp": ' + f_json_level(d_bn) + ',')
array.push(j, '"neck_res": ' + f_json_level(d_brn))
array.push(j, '},')

array.push(j, '"hourly_logic": {')
array.push(j, '"base_supp": ' + f_json_level(h1_bb) + ',')
array.push(j, '"base_res": ' + f_json_level(h1_brb) + ',')
array.push(j, '"neck_supp": ' + f_json_level(h1_bn) + ',')
array.push(j, '"neck_res": ' + f_json_level(h1_brn))
array.push(j, '},')

array.push(j, '"h4_logic": {')
array.push(j, '"neck_supp": ' + f_json_level(h4_bn) + ',')
array.push(j, '"neck_res": ' + f_json_level(h4_brn))
array.push(j, '},')

array.push(j, '"fibs_618": {')
array.push(j, '"h1": ' + f_json_level(fib_1h_618) + ',')
array.push(j, '"d1": ' + f_json_level(fib_d_618) + ',')
array.push(j, '"w1": ' + f_json_level(fib_w_618))
array.push(j, '},')

// --- MACRO OHLC ---
array.push(j, '"htf_daily": {')
array.push(j, '"open": ' + f_json_level(d_o) + ',')
array.push(j, '"high": ' + f_json_level(d_h) + ',')
array.push(j, '"low": ' + f_json_level(d_l) + ',')
array.push(j, '"close": ' + f_json_level(d_c))
array.push(j, '},')

array.push(j, '"htf_weekly": {')
array.push(j, '"open": ' + f_json_level(w_o) + ',')
array.push(j, '"high": ' + f_json_level(w_h) + ',')
array.push(j, '"low": ' + f_json_level(w_l) + ',')
array.push(j, '"close": ' + f_json_level(w_c))
array.push(j, '},')

array.push(j, '"htf_monthly": {')
array.push(j, '"open": ' + f_json_level(m_o) + ',')
array.push(j, '"high": ' + f_json_level(m_h) + ',')
array.push(j, '"low": ' + f_json_level(m_l) + ',')
array.push(j, '"close": ' + f_json_level(m_c))
array.push(j, '}')

array.push(j, '}') // close smart_levels
array.push(j, '}') // close main JSON
    
    string final_json_payload = array.join(j, "")
alert(final_json_payload, alert.freq_once_per_bar)