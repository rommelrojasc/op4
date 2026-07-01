import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchGexAnalysis,
  fetchHistoricalGex,
  fetchHistoricalSpyBars,
  type HistoricalGexResult,
  type SpyBar,
} from '@/services/api/marketData';
import { createChart, LineStyle, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';

/* ─── Dark theme tokens (op3 palette) ─────────────────────────── */
const C = {
  bg:          '#131722',
  surface:     '#1e1e1e',
  card:        '#262626',
  border:      '#2b2b43',
  green:       '#39d98a',
  greenDim:    '#0d2a1a',
  red:         '#ef5350',
  redDim:      '#2a0a0a',
  amber:       '#f5a623',
  amberDim:    '#2a1800',
  blue:        '#2962ff',
  blueDim:     '#071233',
  purple:      '#7c4dff',
  purpleDim:   '#160a38',
  ink:         '#d1d4dc',
  inkMid:      '#9598a1',
  inkLight:    '#787b86',
  rule:        '#2b2b43',
  header:      '#0c111a',
};

/* ─── Types ────────────────────────────────────────────────────── */
type GexRegime = 'positive' | 'negative';
type OptionDir = 'call' | 'put';
type IvRank    = 'low' | 'medium' | 'high';
type TimeSlot  = 'open' | 'midday' | 'powerHour' | 'moc';
type RiskLevel = 'low' | 'medium' | 'high' | 'extreme';

interface StrikeCandidate {
  strike:  number;
  label:   string;
  delta:   string;
  cost:    string;
  pros:    string;
  cons:    string;
  bestFor: string[];
  score:   number;
}

interface ReturnRow {
  strike:    number;
  label:     string;
  type:      'ITM' | 'ATM' | 'OTM';
  delta:     number;
  dollarMove: string;
  pctMove:   string;
  targetPrice: string;
}

interface SetupResult {
  optionType:       string;
  strategy:         string;
  regime:           string;
  regimeColor:      string;
  direction:        string;
  dirColor:         string;
  strikeNum:        number;
  strike:           string;
  spotPrice:        number;
  gexFlip:          number;
  callWall:         number | null;
  putWall:          number | null;
  t1price:          number;
  t2price:          number | null;
  underlyingMove1:  string;
  underlyingMove2:  string | null;
  optionGain1Pct:   string;
  optionGain2Pct:   string;
  stopPct:          number;
  entry:            string;
  target1:          string;
  target2:          string;
  stopLoss:         string;
  wallNote:         string | null;
  wallSupportNote:  string | null;
  why:              string;
  ivNote:           string;
  timeInfo:         { label: string; risk: RiskLevel; note: string };
  risk:             RiskLevel;
  strikeCandidates: StrikeCandidate[];
  rules:            string[];
  nearFlipWarn:     boolean;
  flipPrice:        number;
  vixWarn:          boolean;
  vixBlock:         boolean;
  aboveVT:          boolean | null;
  vtLevel:          number | null;
  sigmaLow:         number | null;
  sigmaHigh:        number | null;
  zeroGammaPartial: number | null;
  checklist:        { label: string; pass: boolean | null; note: string }[];
  returnRange?:     ReturnRow[];
}

/* ─── Shared UI ────────────────────────────────────────────────── */
const Label = ({ children }: { children: React.ReactNode }) => (
  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.13em',
    textTransform: 'uppercase', color: C.inkLight }}>
    {children}
  </span>
);

const Divider = () => (
  <div style={{ height: 1, background: C.rule, margin: '4px 0' }} />
);

function Tag({ children, color = C.green, bg = C.greenDim }:
  { children: React.ReactNode; color?: string; bg?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center',
      padding: '3px 10px', borderRadius: 99, fontSize: 10, fontWeight: 800,
      letterSpacing: '0.1em', textTransform: 'uppercase', color, background: bg,
      border: `1px solid ${color}40` }}>
      {children}
    </span>
  );
}

function ToggleBtn({ active, onClick, children, activeColor = C.green, activeBg = C.greenDim }:
  { active: boolean; onClick: () => void; children: React.ReactNode;
    activeColor?: string; activeBg?: string }) {
  return (
    <button onClick={onClick} style={{ flex: 1, padding: '11px 8px', borderRadius: 10,
      border: `1.5px solid ${active ? activeColor : C.border}`,
      background: active ? activeBg : C.surface,
      color: active ? activeColor : C.inkLight,
      fontSize: 13, fontWeight: 700,
      cursor: 'pointer', transition: 'all 0.18s',
      boxShadow: active ? `0 2px 12px ${activeColor}22` : 'none' }}>
      {children}
    </button>
  );
}

function Field({ label, value, onChange, placeholder, prefix, hint }:
  { label: string; value: string; onChange: (v: string) => void;
    placeholder: string; prefix?: string; hint?: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <Label>{label}</Label>
      <div style={{ position: 'relative' }}>
        {prefix && (
          <span style={{ position: 'absolute', left: 13, top: '50%',
            transform: 'translateY(-50%)', fontSize: 14, fontWeight: 700,
            color: C.inkLight, pointerEvents: 'none', zIndex: 1 }}>{prefix}</span>
        )}
        <input type="number" value={value} onChange={e => onChange(e.target.value)}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          placeholder={placeholder}
          style={{ width: '100%', boxSizing: 'border-box',
            padding: `10px 13px 10px ${prefix ? '25px' : '13px'}`,
            borderRadius: 9, fontSize: 14,
            fontWeight: 600, color: C.ink, background: C.card, outline: 'none',
            border: `1.5px solid ${focused ? C.inkMid : C.border}`,
            transition: 'border 0.15s',
            boxShadow: focused ? `0 0 0 3px ${C.inkMid}18` : 'none' }} />
      </div>
      {hint && <p style={{ margin: 0, fontSize: 10, color: C.inkLight, lineHeight: 1.5 }}>{hint}</p>}
    </div>
  );
}

function SelectField({ label, value, onChange, options }:
  { label: string; value: string; onChange: (v: string) => void;
    options: { value: string; label: string }[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <Label>{label}</Label>
      <select value={value} onChange={e => onChange(e.target.value)} style={{
        padding: '10px 13px', borderRadius: 9, fontSize: 13,
        fontWeight: 600, color: C.ink,
        background: C.card, border: `1.5px solid ${C.border}`,
        outline: 'none', cursor: 'pointer', appearance: 'none',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%23787b86' d='M5 7L0 2h10z'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat', backgroundPosition: 'right 13px center',
      }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function RiskDots({ level }: { level: RiskLevel }) {
  const map: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, extreme: 4 };
  const n    = map[level] || 1;
  const cols = [C.green, C.amber, '#e07b2a', C.red];
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
      {[1,2,3,4].map(i => (
        <div key={i} style={{ width: 22, height: 5, borderRadius: 3,
          background: i <= n ? cols[n - 1] : C.rule }} />
      ))}
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em',
        textTransform: 'uppercase', color: cols[n - 1], marginLeft: 5 }}>{level}</span>
    </div>
  );
}

/* ─── Level Map ─────────────────────────────────────────────────── */
function LevelMap({ spot, callWall, putWall, gexFlip }:
  { spot: number; callWall: number | null; putWall: number | null; gexFlip: number }) {
  // Only show GEX Flip if it's a real value (not just the spot fallback)
  const hasRealFlip = gexFlip !== spot;
  const levels = [
    callWall != null && { price: callWall, label: 'Call Wall', color: C.green, role: 'Resistance' },
    hasRealFlip && { price: gexFlip, label: 'GEX Flip', color: C.amber, role: 'Regime Gate' },
    putWall  != null && { price: putWall,  label: 'Put Wall',  color: C.red,   role: 'Support' },
  ].filter(Boolean) as { price: number; label: string; color: string; role: string }[];

  levels.sort((a, b) => b.price - a.price);

  const allPrices = levels.map(l => l.price).concat(spot);
  const max = Math.max(...allPrices);
  const min = Math.min(...allPrices);
  const range = max - min || 1;
  const pad   = range * 0.15;
  const chartMax   = max + pad;
  const chartRange = chartMax - (min - pad);
  const pct = (p: number) => ((chartMax - p) / chartRange * 100).toFixed(1) + '%';

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: '16px 20px' }}>
      <div style={{ marginBottom: 12 }}><Label>Price Level Map</Label></div>
      <div style={{ position: 'relative', height: 180 }}>
        <div style={{ position: 'absolute', left: 36, top: 0, bottom: 0, width: 3,
          background: C.rule, borderRadius: 2 }} />

        {/* Spot */}
        <div style={{ position: 'absolute', top: pct(spot), left: 0, right: 0,
          display: 'flex', alignItems: 'center', gap: 8, transform: 'translateY(-50%)' }}>
          <div style={{ width: 36, display: 'flex', justifyContent: 'flex-end', paddingRight: 6 }}>
            <div style={{ width: 14, height: 14, borderRadius: '50%',
              background: C.ink, border: '2px solid #0c111a',
              boxShadow: '0 0 0 2px ' + C.ink }} />
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.ink }}>
            ${spot} <span style={{ fontWeight: 400, color: C.inkLight }}>· Spot</span>
          </div>
        </div>

        {levels.map(lvl => (
          <div key={lvl.label} style={{ position: 'absolute', top: pct(lvl.price),
            left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 8,
            transform: 'translateY(-50%)' }}>
            <div style={{ width: 36, display: 'flex', justifyContent: 'flex-end', paddingRight: 4 }}>
              <div style={{ width: 20, height: 4, borderRadius: 2, background: lvl.color }} />
            </div>
            <div style={{ fontSize: 11, color: lvl.color, fontWeight: 700 }}>
              ${lvl.price}
              <span style={{ fontWeight: 400, color: C.inkLight, marginLeft: 4 }}>· {lvl.label}</span>
              <span style={{ fontSize: 9, marginLeft: 6, background: `${lvl.color}22`,
                color: lvl.color, padding: '1px 6px', borderRadius: 4,
                fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                {lvl.role}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        {callWall != null && (
          <div style={{ flex: 1, minWidth: 110, padding: '8px 10px', borderRadius: 8,
            background: C.greenDim, border: `1px solid ${C.green}25` }}>
            <div style={{ fontSize: 9, fontWeight: 800, color: C.green, letterSpacing: '0.1em',
              textTransform: 'uppercase' }}>Call Wall Distance</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.green, marginTop: 2 }}>
              +${(callWall - spot).toFixed(2)}
            </div>
            <div style={{ fontSize: 10, color: C.inkLight }}>
              +{((callWall - spot) / spot * 100).toFixed(2)}% from spot
            </div>
          </div>
        )}
        {putWall != null && (
          <div style={{ flex: 1, minWidth: 110, padding: '8px 10px', borderRadius: 8,
            background: C.redDim, border: `1px solid ${C.red}25` }}>
            <div style={{ fontSize: 9, fontWeight: 800, color: C.red, letterSpacing: '0.1em',
              textTransform: 'uppercase' }}>Put Wall Distance</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.red, marginTop: 2 }}>
              −${(spot - putWall).toFixed(2)}
            </div>
            <div style={{ fontSize: 10, color: C.inkLight }}>
              −{((spot - putWall) / spot * 100).toFixed(2)}% from spot
            </div>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 110, padding: '8px 10px', borderRadius: 8,
          background: C.amberDim, border: `1px solid ${C.amber}20` }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: C.amber, letterSpacing: '0.1em',
            textTransform: 'uppercase' }}>Flip Distance</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.amber, marginTop: 2 }}>
            {spot > gexFlip ? '−' : '+'} ${Math.abs(spot - gexFlip).toFixed(2)}
          </div>
          <div style={{ fontSize: 10, color: C.inkLight }}>
            {((Math.abs(spot - gexFlip)) / spot * 100).toFixed(2)}% from spot
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Strike Picker ─────────────────────────────────────────────── */
function pickBestStrike({ optionType, spot, callWall, putWall, gex, ivRank }:
  { optionType: OptionDir; spot: number; callWall: number | null; putWall: number | null;
    gexFlip: number; gex: GexRegime; ivRank: IvRank }): StrikeCandidate[] {
  const s    = spot;
  const cw   = callWall;
  const pw   = putWall;
  const step = s > 200 ? 1 : 0.5;
  const isCall = optionType === 'call';
  const wallDist = isCall
    ? (cw != null ? Math.abs(cw - s) : null)
    : (pw != null ? Math.abs(s - pw) : null);

  let candidates: StrikeCandidate[];

  if (isCall) {
    const itmStrike  = Math.floor(s / step) * step - step;
    const atmStrike  = Math.round(s / step) * step;
    const otmStrike1 = Math.ceil(s / step) * step + step;
    candidates = [
      {
        strike: itmStrike, label: 'ITM (1 strike in-the-money)',
        delta: '~0.65–0.75', cost: 'Higher premium',
        pros: 'Highest delta — tracks the move dollar-for-dollar best. Less theta decay. Best for slow momentum or bounce plays.',
        cons: 'More expensive. Less % upside if move is big.',
        bestFor: ['positive', 'bounce', 'high_iv'],
        score: gex === 'positive' ? 3 : (ivRank === 'high' ? 2 : 1),
      },
      {
        strike: atmStrike, label: 'ATM (at-the-money)',
        delta: '~0.50', cost: 'Moderate premium',
        pros: 'Best balance of delta and gamma. Maximum gamma sensitivity — benefits most from GEX-amplified moves. The classic 0DTE strike.',
        cons: 'Faster theta decay than ITM. Needs a clear move quickly.',
        bestFor: ['negative', 'momentum', 'medium_iv'],
        score: gex === 'negative' ? 3 : 2,
      },
      {
        strike: otmStrike1, label: 'OTM (1 strike out-of-the-money)',
        delta: '~0.30–0.40', cost: 'Cheapest premium',
        pros: 'Cheapest entry. Highest % return if the move is strong. Ideal for breakout plays when wall distance is wide.',
        cons: 'Lower delta. Needs a bigger move to profit. High theta decay.',
        bestFor: ['negative', 'breakout', 'low_iv'],
        score: (gex === 'negative' && wallDist != null && wallDist > step * 3) ? 3 : 1,
      },
    ];
  } else {
    const itmStrike  = Math.ceil(s / step) * step + step;
    const atmStrike  = Math.round(s / step) * step;
    const otmStrike1 = Math.floor(s / step) * step - step;
    candidates = [
      {
        strike: itmStrike, label: 'ITM (1 strike in-the-money)',
        delta: '~−0.65 to −0.75', cost: 'Higher premium',
        pros: 'Highest delta for puts — tracks every $1 drop most precisely. Safer decay profile. Best for confirmed breakdowns.',
        cons: 'More expensive. Lower % return if move is sharp.',
        bestFor: ['positive', 'fade', 'high_iv'],
        score: gex === 'positive' ? 3 : (ivRank === 'high' ? 2 : 1),
      },
      {
        strike: atmStrike, label: 'ATM (at-the-money)',
        delta: '~−0.50', cost: 'Moderate premium',
        pros: 'Max gamma for puts. GEX negative amplifies the downside move, supercharging your ATM put. Best all-around 0DTE put.',
        cons: 'Fast theta. Needs the breakdown to happen quickly.',
        bestFor: ['negative', 'breakdown', 'medium_iv'],
        score: gex === 'negative' ? 3 : 2,
      },
      {
        strike: otmStrike1, label: 'OTM (1 strike out-of-the-money)',
        delta: '~−0.25 to −0.35', cost: 'Cheapest premium',
        pros: 'Cheapest. Huge % return if the breakdown is violent. Good near the put wall when a breach is expected.',
        cons: 'Needs a large fast move. High chance of expiring worthless.',
        bestFor: ['negative', 'violent_drop', 'low_iv'],
        score: (gex === 'negative' && wallDist != null && wallDist > step * 3) ? 3 : 1,
      },
    ];
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/* ─── 100% Return Calculator ────────────────────────────────────── */
function calc100ReturnRange({ premium, spot, optionType, strikeCandidates }:
  { premium: string; spot: string; optionType: OptionDir; strikeCandidates: StrikeCandidate[] }
): ReturnRow[] | null {
  const prem = parseFloat(premium);
  const s    = parseFloat(spot);
  if (!prem || !s) return null;
  const isCall = optionType === 'call';
  const deltaMap: Record<string, number> = { ITM: 0.70, ATM: 0.50, OTM: 0.32 };
  return strikeCandidates.map(c => {
    const type  = c.label.includes('ITM') ? 'ITM' : c.label.includes('ATM') ? 'ATM' : 'OTM';
    const delta = deltaMap[type];
    const dollarMove  = (prem / delta).toFixed(2);
    const pctMove     = ((prem / delta) / s * 100).toFixed(2);
    const targetPrice = isCall
      ? (s + parseFloat(dollarMove)).toFixed(2)
      : (s - parseFloat(dollarMove)).toFixed(2);
    return { strike: c.strike, label: c.label, type: type as 'ITM'|'ATM'|'OTM',
      delta, dollarMove, pctMove, targetPrice };
  });
}

/* ─── Core Strategy Logic ───────────────────────────────────────── */
function buildSetup({ optionType, gex, spot, gexFlip, callWall, putWall, ivRank, timeOfDay, vix, volTrigger }:
  { optionType: OptionDir; gex: GexRegime; spot: string; gexFlip: string;
    callWall: string; putWall: string; ivRank: IvRank; timeOfDay: TimeSlot;
    vix: string; volTrigger: string }
): SetupResult | null {
  const s  = parseFloat(spot);
  const cw = callWall ? parseFloat(callWall) : null;
  const pw = putWall  ? parseFloat(putWall)  : null;
  if (!s) return null;
  // GEX flip is optional — fall back to spot so downstream math stays valid
  const f  = (gexFlip && !isNaN(parseFloat(gexFlip))) ? parseFloat(gexFlip) : s;

  const isCall    = optionType === 'call';
  // Only warn about flip proximity when we have a real flip value
  const nearFlip  = gexFlip ? Math.abs(s - f) / s < 0.003 : false;
  const atm       = Math.round(s);
  const step      = s > 200 ? 1 : 0.5;

  const timeInfo: Record<TimeSlot, { label: string; risk: RiskLevel; note: string }> = {
    open:      { label: 'Open · 9:30–10:30 AM', risk: 'extreme',
      note: 'Highest vol, fastest moves. MM re-hedging is fiercest. Great for momentum; terrible for mean-reversion.' },
    midday:    { label: 'Midday · 11 AM–2 PM',  risk: 'low',
      note: 'Best window for gamma wall entries — theta pins price to levels, nodes are cleanest. Wait patiently for price AT a max gamma node, verify checklist, then enter.' },
    powerHour: { label: 'Power Hour · 2–3 PM',  risk: 'high',
      note: 'Institutions re-position. Good momentum window. Watch for GEX flip breaks.' },
    moc:       { label: 'MOC · 3–4 PM',          risk: 'extreme',
      note: 'Market-on-close orders move price hard. Gamma effects peak. Exit no later than 3:30 PM.' },
  };
  const t = timeInfo[timeOfDay];

  // VIX & Volatility Trigger
  const vixNum   = vix        ? parseFloat(vix)        : null;
  const vtNum    = volTrigger ? parseFloat(volTrigger) : null;
  const vixWarn  = vixNum != null && vixNum > 25;
  const vixBlock = vixNum != null && vixNum > 30;
  const aboveVT  = (vtNum != null) ? s > vtNum : null;

  // Sigma: 1-day expected range (VIX / √252 × spot)
  const sigmaMove  = vixNum != null ? s * (vixNum / 100) / Math.sqrt(252) : null;
  const sigmaLow   = sigmaMove != null ? parseFloat((s - sigmaMove).toFixed(2)) : null;
  const sigmaHigh  = sigmaMove != null ? parseFloat((s + sigmaMove).toFixed(2)) : null;

  // Zero gamma: mandatory partial exit level
  const zeroGammaPartial = (gexFlip && !isNaN(parseFloat(gexFlip))) ? parseFloat(gexFlip) : null;

  // Pre-trade checklist
  const checklist: { label: string; pass: boolean | null; note: string }[] = [
    {
      label: 'VIX < 30',
      pass: vixNum != null ? vixNum < 30 : null,
      note: vixNum == null ? 'Enter VIX above to auto-verify'
        : vixNum < 25 ? `VIX ${vixNum} — clean conditions, levels reliable`
        : vixNum < 30 ? `VIX ${vixNum} — elevated, reduce size 30%`
        : `VIX ${vixNum} — DANGER: gamma levels break above 30. Stand aside.`,
    },
    {
      label: 'Price AT max gamma node',
      pass: (() => {
        const target = isCall ? pw : cw;
        if (target == null) return null;
        return Math.abs(s - target) / s < 0.005;
      })(),
      note: (() => {
        const target = isCall ? pw : cw;
        if (target == null) return `No ${isCall ? 'put' : 'call'} wall entered — verify price is at max gamma node before entering`;
        const dist = Math.abs(s - target);
        const pct  = (dist / s * 100).toFixed(2);
        return dist / s < 0.005
          ? `Within 0.5% of ${isCall ? 'put' : 'call'} wall ($${target}) — valid entry zone`
          : `$${dist.toFixed(2)} (${pct}%) away from ${isCall ? 'put' : 'call'} wall — wait for price to reach the level`;
      })(),
    },
    {
      label: 'Volatility Trigger identified',
      pass: vtNum != null,
      note: vtNum == null
        ? 'Enter VT from GexBot Research (Discord: "gets spx") — the most important level'
        : aboveVT
          ? `Above VT ($${vtNum}) — MM compresses vol, smooth waves, levels hold. Ideal for wall bounces.`
          : `Below VT ($${vtNum}) — MM amplifies moves, levels can break. Extra caution; reduce size.`,
    },
    {
      label: 'Next gamma node < 50% strength',
      pass: null,
      note: 'Manual: confirm the next gamma node behind your entry is less than half the size. Weak node = level fails easily.',
    },
    {
      label: 'Gasolina between entry & target',
      pass: null,
      note: isCall
        ? 'Verify Short Gamma (purple) nodes exist between put wall and call wall — they fuel the upward move when crossed.'
        : 'Verify Short Gamma (purple) nodes exist between call wall and put wall — they fuel the downward move.',
    },
    {
      label: 'Order flow confirms (liquidating)',
      pass: null,
      note: 'Bookmap/Atas: look for red → green absorption with 2B+ in liquidations at the level. Without this, risk is higher.',
    },
    {
      label: 'Preferred time of day',
      pass: timeOfDay === 'midday' || timeOfDay === 'powerHour',
      note: timeOfDay === 'open'
        ? 'Open is chaotic — MM re-hedging distorts levels. Better to wait until after 11 AM.'
        : timeOfDay === 'midday'
          ? 'Ideal — theta has pinned price to levels, gamma nodes are cleanest and most reliable.'
          : timeOfDay === 'powerHour'
            ? 'Good window — institutions reposition and levels hold well.'
            : 'Too late for new entries. Exit all 0DTE positions before 3:30 PM.',
    },
  ];

  const strikeCandidates = pickBestStrike({ optionType, spot: s, callWall: cw, putWall: pw,
    gexFlip: f, gex, ivRank });
  const bestStrike = strikeCandidates[0];

  if (isCall) {
    if (gex === 'negative') {
      const entryStrike = bestStrike.strike;
      const t1price     = cw != null ? Math.min(cw, entryStrike + step * 3) : entryStrike + step * 2;
      const t2price     = cw ?? (entryStrike + step * 4);
      const move1       = ((t1price - s) / s * 100).toFixed(2);
      const move2       = ((t2price - s) / s * 100).toFixed(2);
      return {
        optionType: 'CALL', strategy: 'Breakout Momentum Call',
        regime: 'Negative GEX → Trend Amplifier', regimeColor: C.red,
        direction: 'BULLISH', dirColor: C.green,
        strikeNum: entryStrike, strike: `$${entryStrike} Call (0DTE)`,
        spotPrice: s, gexFlip: f, callWall: cw, putWall: pw,
        t1price, t2price,
        underlyingMove1: move1, underlyingMove2: move2,
        optionGain1Pct: (parseFloat(move1) * 2.0).toFixed(0),
        optionGain2Pct: (parseFloat(move2) * 2.4).toFixed(0),
        stopPct: 45,
        entry: pw != null
          ? `Enter AT max negative gamma floor — put wall $${pw}. Wait for 1 green 5-min candle confirming bounce at the level. Stop just below $${pw}. Zero gamma ($${f}) is your mandatory partial exit, NOT your entry.`
          : `Enter near spot ($${s.toFixed(2)}) on confirmed bounce from the nearest negative gamma node. 1 green 5-min candle required. Zero gamma ($${f}) is your mandatory partial exit.`,
        target1: `$${t1price}${cw != null && t1price < cw ? ' (before call wall)' : cw != null ? ' (call wall — EXIT HERE)' : ''} → +${move1}% underlying → option ~+${(parseFloat(move1) * 2.0).toFixed(0)}%`,
        target2: cw != null
          ? `$${cw} Call Wall — maximum target. MMs will sell hard here. EXIT before or at the wall.`
          : `$${t2price} (+${move2}% move) → option ~+${(parseFloat(move2) * 2.4).toFixed(0)}% — stretch`,
        stopLoss: pw != null
          ? `Exit if price falls through put wall at $${pw} OR option loses 45% of value.`
          : `Exit if price closes 5-min below $${(entryStrike - step).toFixed(2)} OR option loses 45%.`,
        wallNote: cw != null
          ? `Call Wall at $${cw} is your ceiling. Price will struggle to break it. Take profits BEFORE or AT this level.`
          : `No call wall entered. Watch for natural resistance levels (round numbers, prior highs).`,
        wallSupportNote: pw != null
          ? `Put Wall at $${pw} is your safety floor. If price breaks below it, your bullish thesis is broken — exit immediately.`
          : null,
        why: `In negative GEX, MMs are SHORT gamma. As price rises they are FORCED to buy stock to re-hedge, accelerating your call's value. The call wall at ${cw != null ? '$' + cw : 'resistance'} is where this flow exhausts — it's your exit, not your hold target.`,
        ivNote: ivRank === 'high' ? '⚠ IV HIGH — premium expensive. Size down 30%.' : '✅ IV reasonable for buying a call.',
        timeInfo: t, risk: timeOfDay === 'midday' ? 'medium' : 'high',
        strikeCandidates,
        rules: [
          pw != null ? `Enter AT put wall $${pw} only — that is the max negative gamma floor. Do not chase.` : 'Enter only at the max negative gamma node — do not chase',
          zeroGammaPartial != null ? `⚡ MANDATORY: Take 50% off at zero gamma $${zeroGammaPartial} — move stop to breakeven` : 'Take 50% partial at zero gamma on the way to target — mandatory GexBot rule',
          cw != null ? `Full exit at call wall $${cw} — maximum target, MMs sell hard here` : "Exit remaining at first strong resistance level",
          'Hard stop: 45% loss on the option, no exceptions',
          pw != null ? `Put wall $${pw} breaking = thesis over, exit everything immediately` : 'Exit on any 5-min close below entry node',
          'Trailing stop every 15 min once in profit — per GexBot management rules',
          'Exit entire position by 3:30 PM regardless of P&L',
        ],
        nearFlipWarn: nearFlip, flipPrice: f,
        vixWarn, vixBlock, aboveVT, vtLevel: vtNum, sigmaLow, sigmaHigh, zeroGammaPartial, checklist,
      };
    } else {
      // Positive GEX bounce call
      const entryStrike = bestStrike.strike;
      const t1price = cw != null ? Math.min(atm + step * 2, cw) : atm + step * 2;
      const move1   = ((t1price - s) / s * 100).toFixed(2);
      return {
        optionType: 'CALL', strategy: 'Gamma Wall Bounce Call',
        regime: 'Positive GEX → Range Absorber', regimeColor: C.green,
        direction: 'BULLISH', dirColor: C.green,
        strikeNum: entryStrike, strike: `$${entryStrike} Call (0DTE)`,
        spotPrice: s, gexFlip: f, callWall: cw, putWall: pw,
        t1price, t2price: cw ?? null,
        underlyingMove1: move1,
        underlyingMove2: cw != null ? ((cw - s) / s * 100).toFixed(2) : null,
        optionGain1Pct: (parseFloat(move1) * 1.6).toFixed(0),
        optionGain2Pct: '50',
        stopPct: 45,
        entry: pw != null
          ? `Price must dip toward put wall at $${pw}. Wait for 1 green 5-min candle confirming the bounce before entering.`
          : `Price must dip to gamma wall support below $${s.toFixed(2)}. Enter only on confirmed bounce.`,
        target1: `$${t1price}${cw != null ? ' (approach to call wall)' : ''} → +${move1}% move → option ~+${(parseFloat(move1) * 1.6).toFixed(0)}%`,
        target2: cw != null
          ? `$${cw} Call Wall — hard resistance. Exit at or before wall. Do not hold through it.`
          : `50% option gain — take it. Positive GEX limits upside.`,
        stopLoss: pw != null
          ? `Exit if price BREAKS below put wall at $${pw}. Support is gone — get out.`
          : `Exit if price breaks below bounce entry by more than $${step}.`,
        wallNote: cw != null
          ? `Call Wall at $${cw} is strong resistance. MMs sell into this level. Your profit target should be BELOW it.`
          : null,
        wallSupportNote: pw != null
          ? `Put Wall at $${pw} is your support floor for this trade. This is where you enter (bounce off it). If it breaks, exit.`
          : null,
        why: `In positive GEX, MMs buy dips automatically. The put wall at ${pw != null ? '$' + pw : 'support'} acts as a mechanical floor. Price bounces because MMs are net long gamma and forced to re-buy there. The call wall at ${cw != null ? '$' + cw : 'resistance'} is your exit — MMs sell into it.`,
        ivNote: ivRank === 'high' ? '⚠ IV high — wide spreads. Use limit orders only.' : '✅ Good IV environment for a bounce call.',
        timeInfo: t, risk: 'medium',
        strikeCandidates,
        rules: [
          pw != null ? `Enter AT put wall $${pw} on confirmed bounce — 1 green 5-min candle required` : 'Enter only on confirmed bounce at max negative gamma node',
          zeroGammaPartial != null ? `⚡ MANDATORY: Take 50% off at zero gamma $${zeroGammaPartial} — move stop to breakeven` : 'Take 50% partial at zero gamma on the way to target',
          cw != null ? `Full exit at or before call wall $${cw} — MMs sell mechanically here` : 'Take 40–50% option gain — positive GEX limits moves',
          'Midday is the ideal window — theta pins price to gamma nodes',
          'Trailing stop every 15 min once in profit',
          'Exit by 3:30 PM',
        ],
        nearFlipWarn: nearFlip, flipPrice: f,
        vixWarn, vixBlock, aboveVT, vtLevel: vtNum, sigmaLow, sigmaHigh, zeroGammaPartial, checklist,
      };
    }
  }

  // ── PUT setups ──
  if (gex === 'negative') {
    const entryStrike = bestStrike.strike;
    const t1price     = pw != null ? Math.max(pw, entryStrike - step * 3) : entryStrike - step * 2;
    const t2price     = pw ?? (entryStrike - step * 4);
    const move1       = ((s - t1price) / s * 100).toFixed(2);
    const move2       = ((s - t2price) / s * 100).toFixed(2);
    return {
      optionType: 'PUT', strategy: 'Breakdown Momentum Put',
      regime: 'Negative GEX → Trend Amplifier', regimeColor: C.red,
      direction: 'BEARISH', dirColor: C.red,
      strikeNum: entryStrike, strike: `$${entryStrike} Put (0DTE)`,
      spotPrice: s, gexFlip: f, callWall: cw, putWall: pw,
      t1price, t2price,
      underlyingMove1: move1, underlyingMove2: move2,
      optionGain1Pct: (parseFloat(move1) * 2.0).toFixed(0),
      optionGain2Pct: (parseFloat(move2) * 2.4).toFixed(0),
      stopPct: 45,
      entry: cw != null
        ? `Enter AT max positive gamma ceiling — call wall $${cw}. Wait for 1 red 5-min candle confirming rejection at the level. Stop just above $${cw}. Zero gamma ($${f}) is your mandatory partial exit, NOT your entry.`
        : `Enter near spot ($${s.toFixed(2)}) on confirmed rejection from the nearest positive gamma node. 1 red 5-min candle stall required. Zero gamma ($${f}) is your mandatory partial exit.`,
      target1: `$${t1price}${pw != null && t1price > pw ? ' (above put wall)' : pw != null ? ' (put wall — EXIT HERE)' : ''} → −${move1}% underlying → option ~+${(parseFloat(move1) * 2.0).toFixed(0)}%`,
      target2: pw != null
        ? `$${pw} Put Wall — maximum target. MMs will buy hard here. EXIT before or at the wall.`
        : `$${t2price} (−${move2}% move) → option ~+${(parseFloat(move2) * 2.4).toFixed(0)}% — stretch`,
      stopLoss: cw != null
        ? `Exit if price rallies through call wall at $${cw} OR option loses 45% of value.`
        : `Exit if price closes 5-min above $${(entryStrike + step).toFixed(2)} OR option loses 45%.`,
      wallNote: pw != null
        ? `Put Wall at $${pw} is your floor target. MMs buy hard here. Exit at or BEFORE this level.`
        : `No put wall entered. Watch for natural support (round numbers, prior lows).`,
      wallSupportNote: cw != null
        ? `Call Wall at $${cw} is overhead resistance. If price rallies back through it, your bearish thesis is broken — exit immediately.`
        : null,
      why: `In negative GEX, MMs are SHORT gamma. As price falls they are FORCED to sell stock to re-hedge, accelerating your put. The put wall at ${pw != null ? '$' + pw : 'support'} is where this forced selling exhausts — exit before or at that level.`,
      ivNote: ivRank === 'high' ? '⚠ IV HIGH — puts expensive. Use spread to reduce cost.' : '✅ IV reasonable for buying a put.',
      timeInfo: t, risk: timeOfDay === 'open' ? 'extreme' : 'high',
      strikeCandidates,
      rules: [
        cw != null ? `Enter AT call wall $${cw} only — that is the max positive gamma ceiling. Do not chase.` : 'Enter only at the max positive gamma node — do not chase',
        zeroGammaPartial != null ? `⚡ MANDATORY: Take 50% off at zero gamma $${zeroGammaPartial} — move stop to breakeven` : 'Take 50% partial at zero gamma on the way to target — mandatory GexBot rule',
        pw != null ? `Full exit at put wall $${pw} — maximum target, MMs buy hard here` : "Exit remaining at first strong support level",
        'Hard stop: 45% loss on the option, no exceptions',
        cw != null ? `Call wall $${cw} recaptured = thesis over, exit everything immediately` : 'Exit on any 5-min close above entry node',
        'Trailing stop every 15 min once in profit — per GexBot management rules',
        'Exit entire position by 3:30 PM regardless',
      ],
      nearFlipWarn: nearFlip, flipPrice: f,
      vixWarn, vixBlock, aboveVT, vtLevel: vtNum, sigmaLow, sigmaHigh, zeroGammaPartial, checklist,
    };
  } else {
    // Positive GEX fade put
    const entryStrike = bestStrike.strike;
    const t1price     = pw != null ? Math.max(atm - step * 2, pw) : atm - step * 2;
    const move1       = ((s - t1price) / s * 100).toFixed(2);
    return {
      optionType: 'PUT', strategy: 'Gamma Wall Fade Put',
      regime: 'Positive GEX → Range Absorber', regimeColor: C.green,
      direction: 'BEARISH', dirColor: C.red,
      strikeNum: entryStrike, strike: `$${entryStrike} Put (0DTE)`,
      spotPrice: s, gexFlip: f, callWall: cw, putWall: pw,
      t1price, t2price: pw ?? null,
      underlyingMove1: move1,
      underlyingMove2: pw != null ? ((s - pw) / s * 100).toFixed(2) : null,
      optionGain1Pct: (parseFloat(move1) * 1.6).toFixed(0),
      optionGain2Pct: '50',
      stopPct: 45,
      entry: cw != null
        ? `Wait for price to spike toward call wall at $${cw}. Enter put only after stall (doji or bearish 5-min candle rejecting the wall).`
        : `Wait for price to spike into resistance above $${s.toFixed(2)}. Enter only after stall confirms.`,
      target1: `$${t1price}${pw != null ? ' (approach to put wall)' : ''} → −${move1}% move → option ~+${(parseFloat(move1) * 1.6).toFixed(0)}%`,
      target2: pw != null
        ? `$${pw} Put Wall — strong support. MMs buy hard here. Exit at or before.`
        : `40–50% option gain — take it. Positive GEX limits downside moves.`,
      stopLoss: cw != null
        ? `Exit if price BREAKS above call wall at $${cw}. Resistance broke — MMs lost control.`
        : `Exit if price closes 5-min above your entry level.`,
      wallNote: cw != null
        ? `Call Wall at $${cw} is your entry trigger — price must reject here. MMs sell this level mechanically.`
        : null,
      wallSupportNote: pw != null
        ? `Put Wall at $${pw} is your profit target floor. MMs buy here. Exit at or before — don't hold expecting a wall breach.`
        : null,
      why: `In positive GEX, MMs sell into rallies mechanically. The call wall at ${cw != null ? '$' + cw : 'resistance'} is where this selling is concentrated. Your put profits from the mechanical rejection. Exit near the put wall where MM buying kicks back in.`,
      ivNote: ivRank === 'high' ? '⚠ IV elevated. Consider put debit spread instead.' : '✅ Reasonable IV for a fade put.',
      timeInfo: t, risk: 'medium',
      strikeCandidates,
      rules: [
        cw != null ? `Enter AT call wall $${cw} on confirmed rejection — 1 red 5-min candle stall required` : 'Enter only on confirmed stall at max positive gamma node',
        zeroGammaPartial != null ? `⚡ MANDATORY: Take 50% off at zero gamma $${zeroGammaPartial} — move stop to breakeven` : 'Take 50% partial at zero gamma on the way to target',
        pw != null ? `Full exit at or before put wall $${pw} — MMs buy mechanically here` : 'Take 40–50% option gain — positive GEX limits downside moves',
        'Midday is ideal — theta pins price to gamma nodes, levels are cleanest',
        'Trailing stop every 15 min once in profit',
        'Exit by 3:30 PM',
      ],
      nearFlipWarn: nearFlip, flipPrice: f,
      vixWarn, vixBlock, aboveVT, vtLevel: vtNum, sigmaLow, sigmaHigh, zeroGammaPartial, checklist,
    };
  }
}

/* ─── Pre-Trade Checklist Card ─────────────────────────────────── */
function ChecklistCard({ checklist, vixBlock }: {
  checklist: { label: string; pass: boolean | null; note: string }[];
  vixBlock: boolean;
}) {
  const mandatoryFails = checklist.filter(c => c.pass === false).length;
  const headerColor = vixBlock ? C.red : mandatoryFails > 0 ? C.amber : C.green;
  const headerBg    = vixBlock ? C.redDim : mandatoryFails > 0 ? C.amberDim : C.greenDim;
  const headerIcon  = vixBlock ? '🚫' : mandatoryFails > 0 ? '⚠️' : '✅';
  const headerTitle = vixBlock ? 'VIX > 30 — Do Not Trade' : mandatoryFails > 0 ? `${mandatoryFails} condition${mandatoryFails > 1 ? 's' : ''} failed — review before entering` : 'All auto-checks passed — verify manual items';

  return (
    <div style={{ background: C.surface, border: `1px solid ${headerColor}40`,
      borderTop: `4px solid ${headerColor}`, borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ background: headerBg, padding: '14px 22px',
        borderBottom: `1px solid ${headerColor}25`,
        display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>{headerIcon}</span>
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: headerColor }}>Pre-Trade Checklist · GexBot</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginTop: 1 }}>{headerTitle}</div>
        </div>
      </div>
      <div style={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {checklist.map((item, i) => {
          const color = item.pass === true ? C.green : item.pass === false ? C.red : C.inkLight;
          const bg    = item.pass === true ? C.greenDim : item.pass === false ? C.redDim : C.card;
          const bd    = item.pass === true ? `${C.green}25` : item.pass === false ? `${C.red}30` : C.border;
          const icon  = item.pass === true ? '✅' : item.pass === false ? '❌' : '⬜';
          return (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start',
              padding: '10px 12px', borderRadius: 9, background: bg, border: `1px solid ${bd}` }}>
              <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{icon}</span>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, color, marginBottom: 2, letterSpacing: '0.04em' }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 11, color: item.pass === false ? color : C.inkLight, lineHeight: 1.6 }}>
                  {item.note}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Strike Recommendation Card ───────────────────────────────── */
function StrikeCard({ candidates }: { candidates: StrikeCandidate[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!candidates || candidates.length === 0) return null;
  const best = candidates[0];
  const rest = candidates.slice(1);

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.purple}40`,
      borderTop: `4px solid ${C.purple}`, borderRadius: 16, overflow: 'hidden',
      boxShadow: `0 2px 16px ${C.purple}18` }}>
      <div style={{ background: C.purpleDim, padding: '16px 22px',
        borderBottom: `1px solid ${C.purple}25`,
        display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>🎯</span>
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: C.purple }}>Best Strike to Buy</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginTop: 2 }}>
            Ranked by GEX regime, IV, and wall distances
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Best pick */}
        <div style={{ background: C.purpleDim, border: `1.5px solid ${C.purple}40`,
          borderRadius: 12, padding: '16px 18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between',
            alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            <div>
              <Tag color={C.purple} bg={`${C.purple}18`}>✦ Recommended</Tag>
              <div style={{ fontSize: 24, fontWeight: 800, color: C.purple,
                letterSpacing: '-0.02em', marginTop: 8 }}>
                {best.strike} {best.label.split(' ')[0]}
              </div>
              <div style={{ fontSize: 12, color: C.inkMid, marginTop: 2 }}>{best.label}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: C.inkLight,
                textTransform: 'uppercase', letterSpacing: '0.08em' }}>Delta</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.purple }}>{best.delta}</div>
              <div style={{ fontSize: 11, color: C.inkLight, marginTop: 2 }}>{best.cost}</div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.7,
            background: C.card, padding: '10px 12px', borderRadius: 8 }}>
            <strong style={{ color: C.green }}>✅ Why:</strong> {best.pros}
          </div>
          <div style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.7, marginTop: 8,
            background: C.card, padding: '10px 12px', borderRadius: 8 }}>
            <strong style={{ color: C.amber }}>⚠ Watch:</strong> {best.cons}
          </div>
        </div>

        <button onClick={() => setExpanded(e => !e)} style={{
          background: 'none', border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '8px 14px', fontSize: 12, fontWeight: 700, color: C.inkMid,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          {expanded ? '▲ Hide' : '▼ Show'} alternative strikes
        </button>

        {expanded && rest.map(c => (
          <div key={c.strike} style={{ background: C.card, border: `1px solid ${C.border}`,
            borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.ink }}>
                  {c.strike} <span style={{ fontSize: 12, fontWeight: 400,
                    color: C.inkLight }}>{c.label}</span>
                </div>
              </div>
              <div style={{ fontSize: 11, color: C.inkLight }}>δ {c.delta} · {c.cost}</div>
            </div>
            <div style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.6 }}>
              <strong style={{ color: C.green }}>✅</strong> {c.pros}
            </div>
            <div style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.6, marginTop: 4 }}>
              <strong style={{ color: C.amber }}>⚠</strong> {c.cons}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Return Range Card ─────────────────────────────────────────── */
function ReturnRangeCard({ returnRange, optionType, spot, premium, contracts }:
  { returnRange: ReturnRow[]; optionType: string; spot: number;
    premium: string; contracts: string }) {
  const isCall = optionType === 'call' || optionType === 'CALL';
  const prem   = parseFloat(premium);
  const contr  = Math.max(1, parseInt(contracts) || 1);
  const s      = spot;
  const cost   = prem * 100 * contr;
  const arrow  = isCall ? '▲' : '▼';
  const dirWord = isCall ? 'rises' : 'falls';

  const atmRow = returnRange.find(r => r.type === 'ATM') || returnRange[0];
  const itmRow = returnRange.find(r => r.type === 'ITM');
  const otmRow = returnRange.find(r => r.type === 'OTM');

  function rowTargets(row: ReturnRow) {
    const move100 = parseFloat(row.dollarMove);
    const move50  = move100 / 2;
    const pct100  = parseFloat(row.pctMove);
    const pct50   = pct100 / 2;
    const price100 = isCall ? (s + move100).toFixed(2) : (s - move100).toFixed(2);
    const price50  = isCall ? (s + move50).toFixed(2)  : (s - move50).toFixed(2);
    return { move100: move100.toFixed(2), pct100: pct100.toFixed(2), price100,
             move50: move50.toFixed(2),   pct50:  pct50.toFixed(2),  price50,
             gain100: cost, gain50: cost * 0.5 };
  }

  const atmT = rowTargets(atmRow);

  // Realism check
  const normalRange   = s * 0.0035;
  const moderateRange = s * 0.007;
  const highVolRange  = s * 0.015;
  const move50  = parseFloat(atmT.move50);
  const move100 = parseFloat(atmT.move100);

  function realism(move: number) {
    if (move <= normalRange * 0.6)   return { verdict: 'Very Easy',               color: C.green, bg: C.greenDim, icon: '✅' };
    if (move <= normalRange)          return { verdict: 'Realistic — Normal Day',  color: C.green, bg: C.greenDim, icon: '✅' };
    if (move <= moderateRange)        return { verdict: 'Needs Moderate Vol Day',  color: C.amber, bg: C.amberDim, icon: '⚠️' };
    if (move <= highVolRange)         return { verdict: 'Needs High Vol (FOMC/CPI)', color: C.amber, bg: C.amberDim, icon: '⚠️' };
    return { verdict: 'Unlikely — Move Too Large', color: C.red, bg: C.redDim, icon: '❌' };
  }

  const r50  = realism(move50);
  const r100 = realism(move100);

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.green}30`,
      borderTop: `4px solid ${C.green}`, borderRadius: 16, overflow: 'hidden',
      boxShadow: `0 2px 16px ${C.green}10` }}>

      <div style={{ background: C.greenDim, padding: '14px 22px',
        borderBottom: `1px solid ${C.green}20`,
        display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>📐</span>
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: C.green }}>Return Targets · 50% & 100%</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginTop: 1 }}>
            Exact stock move & dollar gain for each return level
          </div>
        </div>
      </div>

      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ATM hero */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: C.inkLight, marginBottom: 10 }}>
            ATM Strike {atmRow.strike} · {contr} Contract{contr > 1 ? 's' : ''} · ${prem.toFixed(2)} Premium
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 140, padding: '16px 16px', borderRadius: 13,
              background: C.amberDim, border: `1.5px solid ${C.amber}30` }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.13em',
                textTransform: 'uppercase', color: C.amber, marginBottom: 8 }}>50% Return</div>
              <div style={{ fontSize: 30, fontWeight: 800, color: C.amber,
                letterSpacing: '-0.02em', lineHeight: 1 }}>+${atmT.gain50.toFixed(0)}</div>
              <div style={{ fontSize: 11, color: C.inkMid, marginTop: 6, lineHeight: 1.6 }}>
                Stock {dirWord} <strong>${atmT.move50}</strong> ({atmT.pct50}%)<br />
                → <strong>${atmT.price50}</strong>
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 140, padding: '16px 16px', borderRadius: 13,
              background: C.greenDim, border: `1.5px solid ${C.green}30` }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.13em',
                textTransform: 'uppercase', color: C.green, marginBottom: 8 }}>100% Return (2×)</div>
              <div style={{ fontSize: 30, fontWeight: 800, color: C.green,
                letterSpacing: '-0.02em', lineHeight: 1 }}>+${atmT.gain100.toFixed(0)}</div>
              <div style={{ fontSize: 11, color: C.inkMid, marginTop: 6, lineHeight: 1.6 }}>
                Stock {dirWord} <strong>${atmT.move100}</strong> ({atmT.pct100}%)<br />
                → <strong>${atmT.price100}</strong>
              </div>
            </div>
          </div>
        </div>

        {/* Realism ranges */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { label: 'Normal Day',       range: `$${normalRange.toFixed(0)}`,   color: C.green },
            { label: 'Moderate Vol',     range: `$${moderateRange.toFixed(0)}`, color: C.amber },
            { label: 'High Vol / Event', range: `$${highVolRange.toFixed(0)}`,  color: C.red },
          ].map(r => (
            <div key={r.label} style={{ flex: 1, minWidth: 90, padding: '9px 10px',
              borderRadius: 8, background: C.card, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase',
                letterSpacing: '0.08em', color: C.inkLight, marginBottom: 3 }}>{r.label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: r.color }}>{r.range} move</div>
              <div style={{ fontSize: 9, color: C.inkLight }}>typical SPX range</div>
            </div>
          ))}
        </div>

        {/* Verdict */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            { label: `50% · $${move50}`, ...r50 },
            { label: `100% · $${move100}`, ...r100 },
          ].map(r => (
            <div key={r.label} style={{ flex: 1, minWidth: 130, padding: '13px 14px',
              borderRadius: 11, background: r.bg, border: `1.5px solid ${r.color}30` }}>
              <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase',
                letterSpacing: '0.1em', color: r.color, marginBottom: 5 }}>{r.label}</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: r.color }}>
                {r.icon} {r.verdict}
              </div>
            </div>
          ))}
        </div>

        {/* All strikes comparison */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: C.inkLight, marginBottom: 10 }}>
            All Strikes — 50% & 100% Return
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[itmRow, atmRow, otmRow].filter(Boolean).map(row => {
              const t = rowTargets(row!);
              const isRec = row!.type === 'ATM';
              return (
                <div key={row!.type} style={{ borderRadius: 11,
                  background: isRec ? C.greenDim : C.card,
                  border: `1.5px solid ${isRec ? C.green + '50' : C.border}`,
                  overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px',
                    borderBottom: `1px solid ${isRec ? C.green + '25' : C.rule}`,
                    background: isRec ? `${C.green}12` : C.card }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 13, fontWeight: 800,
                        color: isRec ? C.green : C.ink }}>{row!.type}&nbsp;</span>
                      <span style={{ fontSize: 12, color: C.inkLight }}>
                        Strike {row!.strike} · δ {isCall ? '' : '−'}{row!.delta} · {
                          row!.type === 'ITM' ? 'Higher premium'
                            : row!.type === 'ATM' ? 'Moderate premium' : 'Cheapest'}
                      </span>
                    </div>
                    {isRec && <Tag color={C.green} bg={`${C.green}18`}>★ Recommended</Tag>}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1px 1fr' }}>
                    <div style={{ padding: '12px 14px' }}>
                      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.1em',
                        textTransform: 'uppercase', color: C.amber, marginBottom: 4 }}>50% Return</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: C.amber }}>+${t.gain50.toFixed(0)}</div>
                      <div style={{ fontSize: 11, color: C.inkLight, marginTop: 3, lineHeight: 1.5 }}>
                        {arrow} ${t.move50} ({t.pct50}%)<br />→ ${t.price50}
                      </div>
                    </div>
                    <div style={{ background: C.rule }} />
                    <div style={{ padding: '12px 14px' }}>
                      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.1em',
                        textTransform: 'uppercase', color: C.green, marginBottom: 4 }}>100% (2×)</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: C.green }}>+${t.gain100.toFixed(0)}</div>
                      <div style={{ fontSize: 11, color: C.inkLight, marginTop: 3, lineHeight: 1.5 }}>
                        {arrow} ${t.move100} ({t.pct100}%)<br />→ ${t.price100}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <p style={{ margin: 0, fontSize: 10, color: C.inkLight, lineHeight: 1.6 }}>
          * Uses constant-delta approximation. In negative GEX regimes gamma acceleration means you may hit targets with a smaller move than shown.
        </p>
      </div>
    </div>
  );
}

/* ─── P&L Card ──────────────────────────────────────────────────── */
function PnLCard({ result, premium, contracts }:
  { result: SetupResult; premium: string; contracts: string }) {
  const prem  = parseFloat(premium);
  const contr = Math.max(1, parseInt(contracts) || 1);
  const cost   = prem * 100 * contr;
  const t1gain = cost * (parseFloat(result.optionGain1Pct) / 100);
  const t2gain = cost * (parseFloat(result.optionGain2Pct) / 100);
  const stopDollar = cost * (result.stopPct / 100);
  const rr     = (t1gain / stopDollar).toFixed(1);
  const beMove = (prem / result.spotPrice * 100).toFixed(2);

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.blue}30`,
      borderTop: `4px solid ${C.blue}`, borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ background: C.blueDim, padding: '14px 22px',
        borderBottom: `1px solid ${C.blue}20`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>📊</span>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: C.blue }}>P&L Calculator</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, marginTop: 1 }}>
              {contr} contract{contr > 1 ? 's' : ''} · ${prem.toFixed(2)} premium
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase',
            letterSpacing: '0.1em', color: C.blue }}>Total Outlay</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.blue }}>${cost.toFixed(2)}</div>
        </div>
      </div>

      <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Price context */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { label: 'Spot',       val: `$${result.spotPrice.toFixed(2)}`, color: C.ink },
            { label: 'Strike',     val: `${result.strikeNum}`,             color: result.dirColor },
            { label: 'GEX Flip',   val: `$${result.gexFlip.toFixed(2)}`,  color: C.amber },
            result.callWall != null ? { label: 'Call Wall', val: `$${result.callWall}`, color: C.green } : null,
            result.putWall  != null ? { label: 'Put Wall',  val: `$${result.putWall}`,  color: C.red   } : null,
          ].filter(Boolean).map(item => {
            const { label, val, color } = item!;
            return (
              <div key={label} style={{ flex: 1, minWidth: 80, padding: '10px 10px',
                borderRadius: 9, background: C.card, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: C.inkLight, marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color }}>{val}</div>
              </div>
            );
          })}
        </div>

        {/* Outcomes */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            { label: `Target 1 · +${result.optionGain1Pct}%`, value: `+$${t1gain.toFixed(0)}`,
              sub: `Underlying → $${result.t1price}`, color: C.green, bg: C.greenDim },
            { label: `Target 2 · +${result.optionGain2Pct}%`, value: `+$${t2gain.toFixed(0)}`,
              sub: result.t2price ? `Wall target → $${result.t2price}` : 'Stretch / time-based',
              color: C.green, bg: C.greenDim },
            { label: `Stop · −${result.stopPct}%`, value: `−$${stopDollar.toFixed(0)}`,
              sub: 'Hard exit, no averaging', color: C.red, bg: C.redDim },
          ].map(box => (
            <div key={box.label} style={{ flex: 1, minWidth: 100, padding: '13px 12px',
              borderRadius: 11, background: box.bg, border: `1px solid ${box.color}25`,
              display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: C.inkLight }}>{box.label}</div>
              <div style={{ fontSize: 19, fontWeight: 800, color: box.color,
                letterSpacing: '-0.02em' }}>{box.value}</div>
              <div style={{ fontSize: 10, color: C.inkLight, lineHeight: 1.4 }}>{box.sub}</div>
            </div>
          ))}
        </div>

        {/* R/R + break-even */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, padding: '14px 16px', borderRadius: 11,
            background: C.blueDim, border: `1px solid ${C.blue}20` }}>
            <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase',
              letterSpacing: '0.1em', color: C.blue, marginBottom: 3 }}>Reward / Risk</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: C.blue }}>{rr} : 1</div>
            <div style={{ fontSize: 11, color: C.blue, marginTop: 2 }}>
              Win ${t1gain.toFixed(0)} · Risk ${stopDollar.toFixed(0)}
            </div>
          </div>
          <div style={{ flex: 1, padding: '14px 16px', borderRadius: 11,
            background: C.amberDim, border: `1px solid ${C.amber}20` }}>
            <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase',
              letterSpacing: '0.1em', color: C.amber, marginBottom: 3 }}>Underlying Break-even</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: C.amber }}>{beMove}%</div>
            <div style={{ fontSize: 11, color: C.amber, marginTop: 2 }}>
              Stock must move this % just to not lose money
            </div>
          </div>
        </div>

        <p style={{ margin: 0, fontSize: 10, color: C.inkLight, lineHeight: 1.6 }}>
          * Gain % uses delta/gamma approximations for ATM/near-ATM 0DTE. Actual results vary with IV crush, spread, and exit timing.
        </p>
      </div>
    </div>
  );
}

/* ─── Main component ────────────────────────────────────────────── */
/* ─── Historical mode helpers ──────────────────────────────────── */

const TIME_STEPS: string[] = (() => {
  const steps: string[] = [];
  for (let h = 9; h <= 15; h++) {
    const startMin = h === 9 ? 30 : 0;
    const endMin   = h === 15 ? 59 : 59;
    for (let m = startMin; m <= endMin; m++) {
      steps.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return steps;
})();

function fmtTs(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York', hour12: false,
  });
}

interface IntradayChartProps {
  bars: SpyBar[];
  gex: HistoricalGexResult | null;
  entryTime: string;
  date: string;
}

function IntradayChart({ bars, gex, entryTime, date }: IntradayChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const seriesRef    = useRef<ISeriesApi<'Line'> | null>(null);

  // Create/recreate chart when bars or GEX levels change
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !bars.length) return;

    const chart = createChart(el, {
      width:  el.clientWidth,
      height: 260,
      layout: {
        background: { type: ColorType.Solid, color: C.card },
        textColor:  C.inkLight,
      },
      grid: {
        vertLines: { color: `${C.border}55` },
        horzLines: { color: `${C.border}33` },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: C.border },
      localization: {
        timeFormatter: (ts: UTCTimestamp | { year: number; month: number; day: number }) => {
          if (typeof ts !== 'number') return '';
          return new Date(ts * 1000).toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit',
            timeZone: 'America/New_York', hour12: false,
          });
        },
      },
      timeScale: {
        borderColor:    C.border,
        timeVisible:    true,
        secondsVisible: false,
        fixLeftEdge:    true,
        fixRightEdge:   true,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
      handleScale:  { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;

    const series = chart.addLineSeries({
      color:     C.blue,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    seriesRef.current = series;
    series.setData(bars.map(b => ({ time: b.time as UTCTimestamp, value: b.close })));

    // GEX price lines (only when GEX is loaded)
    if (gex?.call_wall?.strike)  series.createPriceLine({ price: gex.call_wall.strike,  color: C.green,  lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Call Wall' });
    if (gex?.put_wall?.strike)   series.createPriceLine({ price: gex.put_wall.strike,   color: C.red,    lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Put Wall' });
    if (gex?.gamma_flip?.strike) series.createPriceLine({ price: gex.gamma_flip.strike, color: C.purple, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'GEX Flip' });

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (el) chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [bars, gex, date]);

  // Update only the entry marker when slider moves — no chart recreation
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !bars.length) return;

    const [hh, mm] = entryTime.split(':').map(Number);
    const targetMins = hh * 60 + mm;
    let entryBar = bars[0];
    let bestDiff = Infinity;
    for (const b of bars) {
      const t = fmtTs(b.time).split(':').map(Number);
      const diff = Math.abs(t[0] * 60 + t[1] - targetMins);
      if (diff < bestDiff) { bestDiff = diff; entryBar = b; }
    }
    series.setMarkers([{
      time:     entryBar.time as UTCTimestamp,
      position: 'aboveBar',
      color:    C.amber,
      shape:    'arrowDown',
      text:     `Entry ${entryTime}`,
      size:     1,
    }]);
  }, [entryTime, bars]);

  const levels = [
    gex?.call_wall?.strike  && { label: 'Call Wall', color: C.green },
    gex?.put_wall?.strike   && { label: 'Put Wall',  color: C.red },
    gex?.gamma_flip?.strike && { label: 'GEX Flip',  color: C.purple },
  ].filter(Boolean) as { label: string; color: string }[];

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 13,
      padding: '16px 0 10px', marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '0 14px', marginBottom: 10 }}>
        <p style={{ margin: 0, fontSize: 11, fontWeight: 700,
          color: C.inkLight, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          SPY Intraday · {date}
        </p>
        <span style={{ fontSize: 9, color: C.inkLight }}>scroll to zoom · drag to pan</span>
      </div>
      <div ref={containerRef} />
      <div style={{ display: 'flex', gap: 14, marginTop: 10, paddingLeft: 14, flexWrap: 'wrap' }}>
        {levels.map(({ label, color }) => (
          <span key={label} style={{ fontSize: 9, color, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ display: 'inline-block', width: 16, height: 1.5, background: color }} />
            {label}
          </span>
        ))}
        <span style={{ fontSize: 9, color: C.amber, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ display: 'inline-block', width: 16, height: 1.5, background: C.amber }} />
          Entry ▼
        </span>
      </div>
    </div>
  );
}

function inferTimeSlot(time: string): TimeSlot {
  const [h, m] = time.split(':').map(Number);
  const mins = h * 60 + m;
  if (mins <= 10 * 60 + 30) return 'open';
  if (mins < 14 * 60)       return 'midday';
  if (mins < 15 * 60)       return 'powerHour';
  return 'moc';
}

function inferOptionType(regime: string | undefined, spot: number, flipStrike: number | undefined): OptionDir {
  if (flipStrike != null) return spot >= flipStrike ? 'call' : 'put';
  return (regime === 'BULLISH' || regime === 'POSITIVE_GAMMA') ? 'call' : 'put';
}

export function ZeroDteTool() {
  const [optionType, setOptionType] = useState<OptionDir>('call');
  const [gex,        setGex]        = useState<GexRegime>('negative');
  const [spot,       setSpot]       = useState('');
  const [gexFlip,    setGexFlip]    = useState('');
  const [callWall,   setCallWall]   = useState('');
  const [putWall,    setPutWall]    = useState('');
  const [ivRank,     setIvRank]     = useState<IvRank>('medium');
  const [timeOfDay,  setTimeOfDay]  = useState<TimeSlot>('open');
  const [vix,        setVix]        = useState('');
  const [volTrigger, setVolTrigger] = useState('');
  const [premium,    setPremium]    = useState('');
  const [contracts,  setContracts]  = useState('1');
  const [result,     setResult]     = useState<SetupResult | null>(null);
  const [autoLoaded, setAutoLoaded] = useState<string | null>(null);

  // Historical mode state
  const [histMode,       setHistMode]       = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  // Default to last trading day (skip weekends so we always start with real data)
  function lastTradingDay(): string {
    const d = new Date();
    const day = d.getDay();
    if (day === 0) d.setDate(d.getDate() - 2); // Sunday → Friday
    else if (day === 6) d.setDate(d.getDate() - 1); // Saturday → Friday
    return d.toISOString().slice(0, 10);
  }
  const [histDate,       setHistDate]       = useState(lastTradingDay);
  const [histTimeIdx,    setHistTimeIdx]    = useState(Math.floor(TIME_STEPS.length / 4)); // ~10:00
  const [histGex,        setHistGex]        = useState<HistoricalGexResult | null>(null);
  const [histBars,       setHistBars]       = useState<SpyBar[]>([]);
  const [histLoading,    setHistLoading]    = useState(false);
  const [histBarsLoading, setHistBarsLoading] = useState(false);
  const [histError,      setHistError]      = useState<string | null>(null);
  const histTime = TIME_STEPS[histTimeIdx];

  // Auto-fetch SPY price bars when date changes in historical mode (fast — just stock bars)
  useEffect(() => {
    if (!histMode || !histDate) return;
    setHistBars([]);
    setHistGex(null);
    setResult(null);
    setHistError(null);
    setHistBarsLoading(true);
    fetchHistoricalSpyBars(histDate)
      .then(r => {
        const bars = r.bars ?? [];
        if (bars.length === 0) setHistError('No price data for this date — pick a weekday when markets were open.');
        else setHistBars(bars);
      })
      .catch(err => setHistError(err instanceof Error ? err.message : 'Failed to load SPY bars'))
      .finally(() => setHistBarsLoading(false));
  }, [histDate, histMode]);

  async function loadHistorical() {
    setHistLoading(true);
    setHistError(null);
    setResult(null);
    try {
      const [gexResult, barsResult] = await Promise.all([
        fetchHistoricalGex(histDate, histTime, 25),
        fetchHistoricalSpyBars(histDate),
      ]);
      setHistGex(gexResult);
      setHistBars(barsResult.bars ?? []);

      // Resolve all values locally so we can generate immediately
      const rSpot     = gexResult.spot ? String(Math.round(gexResult.spot * 100) / 100) : '';
      const rFlip     = gexResult.gamma_flip?.strike ? String(gexResult.gamma_flip.strike) : '';
      const rCallWall = gexResult.call_wall?.strike   ? String(gexResult.call_wall.strike)  : '';
      const rPutWall  = gexResult.put_wall?.strike    ? String(gexResult.put_wall.strike)   : '';
      const rGex: GexRegime   = (gexResult.regime === 'BULLISH' || gexResult.regime === 'POSITIVE_GAMMA') ? 'positive' : 'negative';
      const rOptType: OptionDir = inferOptionType(
        gexResult.regime, gexResult.spot ?? 0, gexResult.gamma_flip?.strike
      );
      const rTimeSlot: TimeSlot = inferTimeSlot(histTime);

      // Sync state (drives the form display)
      setSpot(rSpot);
      setGexFlip(rFlip);
      setCallWall(rCallWall);
      setPutWall(rPutWall);
      setGex(rGex);
      setOptionType(rOptType);
      setTimeOfDay(rTimeSlot);
      setAutoLoaded(`${histDate} ${histTime}`);

      // Auto-generate strategy with resolved values (no waiting for state flush)
      if (rSpot) {
        const setup = buildSetup({
          optionType: rOptType,
          gex: rGex,
          spot: rSpot,
          gexFlip: rFlip,
          callWall: rCallWall,
          putWall: rPutWall,
          ivRank,
          timeOfDay: rTimeSlot,
          vix,
          volTrigger,
        });
        if (setup) setResult(setup);
      }
    } catch (err: unknown) {
      setHistError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setHistLoading(false);
    }
  }

  // Live GEX load via op3 API
  const gexQuery = useQuery({
    queryKey: ['gex-analysis-0dte'],
    queryFn: () => fetchGexAnalysis('SPX', '0dte', 100),
    enabled: false,
    retry: 1,
  });

  function loadFromIb() {
    gexQuery.refetch().then(({ data }) => {
      if (!data || data.error) return;
      if (data.spot)                setSpot(String(data.spot));
      if (data.gamma_flip?.strike)  setGexFlip(String(data.gamma_flip.strike));
      if (data.call_wall?.strike)   setCallWall(String(data.call_wall.strike));
      if (data.put_wall?.strike)    setPutWall(String(data.put_wall.strike));
      if (data.regime)
        setGex(data.regime === 'POSITIVE_GAMMA' || data.regime === 'BULLISH' ? 'positive' : 'negative');
      setAutoLoaded(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
    });
  }

  const ready = !!spot;

  function generate() {
    if (!ready) return;
    const setup = buildSetup({ optionType, gex, spot, gexFlip, callWall, putWall, ivRank, timeOfDay, vix, volTrigger });
    if (!setup) return;
    if (premium && parseFloat(premium) > 0) {
      setup.returnRange = calc100ReturnRange({
        premium, spot, optionType, strikeCandidates: setup.strikeCandidates,
      }) ?? undefined;
    }
    setResult(setup);
  }

  function reset() {
    setResult(null);
    setPremium('');
    setContracts('1');
    // In historical mode, keep the loaded data — user can tweak date/time and reload
    if (!histMode) {
      setSpot(''); setGexFlip(''); setCallWall(''); setPutWall('');
      setHistGex(null); setHistBars([]);
    }
  }

  const isCall      = optionType === 'call';
  const accentColor = isCall ? C.green : C.red;
  const accentDim   = isCall ? C.greenDim : C.redDim;

  return (
    <div style={{ minHeight: '100%', background: C.bg, color: C.ink,
      overflowY: 'auto', paddingBottom: 60 }}>

      {/* Header */}
      <div style={{ background: C.header, borderBottom: `1px solid ${C.border}`,
        padding: '20px 32px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 12 }}>
          <div>
            <p style={{ margin: 0, fontSize: 10, letterSpacing: '0.18em',
              color: C.inkLight, textTransform: 'uppercase', marginBottom: 4 }}>
              Options · Zero Days to Expiry
            </p>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.ink,
              letterSpacing: '-0.01em', lineHeight: 1.2 }}>
              0DTE Directional Strategy Engine
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: C.inkLight }}>
              GEX + Gamma Walls · Best Strike Finder · P&L Calculator
            </p>
          </div>

          {/* Mode toggle + load buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
            {/* Live / Historical toggle */}
            <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden',
              border: `1px solid ${C.border}` }}>
              {(['Live', 'Historical'] as const).map(mode => {
                const active = histMode === (mode === 'Historical');
                return (
                  <button key={mode} onClick={() => setHistMode(mode === 'Historical')}
                    style={{ padding: '6px 14px', border: 'none',
                      background: active ? C.blue : C.surface,
                      color: active ? '#fff' : C.inkLight,
                      fontSize: 11, fontWeight: 700, cursor: 'pointer',
                      transition: 'all 0.15s' }}>
                    {mode === 'Live' ? '⚡ Live' : '📅 Historical'}
                  </button>
                );
              })}
            </div>

            {!histMode ? (
              <>
                <button onClick={loadFromIb} disabled={gexQuery.isFetching}
                  style={{ padding: '8px 16px', borderRadius: 9, border: `1.5px solid ${C.blue}`,
                    background: gexQuery.isFetching ? C.card : C.blueDim,
                    color: C.blue, fontSize: 12, fontWeight: 700,
                    cursor: gexQuery.isFetching ? 'not-allowed' : 'pointer',
                    opacity: gexQuery.isFetching ? 0.6 : 1 }}>
                  {gexQuery.isFetching ? '⟳ Loading…' : '⚡ Load from IB · SPX'}
                </button>
                {gexQuery.isError && <span style={{ fontSize: 10, color: C.red }}>IB unavailable</span>}
                {autoLoaded && !gexQuery.isFetching && !gexQuery.isError && (
                  <span style={{ fontSize: 10, color: C.green }}>✓ Loaded {autoLoaded}</span>
                )}
              </>
            ) : (
              <span style={{ fontSize: 10, color: C.inkLight }}>
                Select date &amp; time below
              </span>
            )}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '20px 18px' }}>

        {/* Warning banner */}
        <div style={{ background: C.amberDim, border: `1px solid ${C.amber}35`,
          borderLeft: `4px solid ${C.amber}`, borderRadius: 10,
          padding: '12px 16px', marginBottom: 20,
          display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
          <p style={{ margin: 0, fontSize: 12, color: C.amber, lineHeight: 1.7 }}>
            <strong>0DTE options decay to zero in hours.</strong> Risk no more than 1–2% of account per trade. Educational tool only — not financial advice.
          </p>
        </div>

        {/* Historical backtesting panel */}
        {histMode && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 14, padding: '18px 20px', marginBottom: 20 }}>
            <p style={{ margin: '0 0 14px', fontSize: 10, fontWeight: 800,
              letterSpacing: '0.13em', textTransform: 'uppercase', color: C.inkLight }}>
              📅 Historical Backtest — SPY
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              {/* Date picker */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <Label>Date</Label>
                <input type="date" value={histDate}
                  onChange={e => setHistDate(e.target.value)}
                  max={today}
                  style={{ padding: '9px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                    color: C.ink, background: C.card, border: `1.5px solid ${C.border}`,
                    outline: 'none', width: '100%', boxSizing: 'border-box' as const }} />
              </div>
              {/* Entry time */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <Label>Entry Time (ET) — {histTime}</Label>
                <input type="range" min={0} max={TIME_STEPS.length - 1}
                  value={histTimeIdx}
                  onChange={e => setHistTimeIdx(Number(e.target.value))}
                  style={{ accentColor: C.blue, width: '100%', marginTop: 4 }} />
                <div style={{ display: 'flex', justifyContent: 'space-between',
                  fontSize: 9, color: C.inkLight }}>
                  <span>9:30</span><span>12:00</span><span>15:59</span>
                </div>
              </div>
            </div>

            {/* Intraday chart — loads immediately when date is selected */}
            {histBarsLoading && (
              <div style={{ marginTop: 14, padding: '12px 16px', borderRadius: 10,
                background: C.card, border: `1px solid ${C.border}`,
                fontSize: 12, color: C.inkLight, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'inline-block', width: 12, height: 12,
                  border: `2px solid ${C.blue}`, borderTopColor: 'transparent',
                  borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                Loading SPY price chart…
              </div>
            )}

            {histError && !histBarsLoading && histBars.length === 0 && (
              <div style={{ marginTop: 10, padding: '10px 13px', borderRadius: 8,
                background: C.amberDim, border: `1px solid ${C.amber}30`,
                fontSize: 12, color: C.amber }}>
                ⚠ {histError}
              </div>
            )}

            {histBars.length > 0 && (
              <IntradayChart
                bars={histBars}
                gex={histGex}
                entryTime={histTime}
                date={histDate}
              />
            )}

            {/* Divider + GEX analysis section */}
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
              <p style={{ margin: '0 0 12px', fontSize: 11, color: C.inkLight, lineHeight: 1.6 }}>
                Pick an entry time on the chart above, then load the GEX analysis for that moment.
                This takes 30–90 s (fetches option bars from Polygon).
              </p>

              <button onClick={loadHistorical} disabled={histLoading}
                style={{ width: '100%', padding: '11px', borderRadius: 9, border: 'none',
                  background: histLoading ? C.card : C.purple,
                  color: histLoading ? C.inkLight : '#fff',
                  fontSize: 13, fontWeight: 700,
                  cursor: histLoading ? 'not-allowed' : 'pointer',
                  opacity: histLoading ? 0.7 : 1,
                  boxShadow: histLoading ? 'none' : `0 4px 18px ${C.purple}40`,
                  transition: 'all 0.2s' }}>
                {histLoading ? '⟳ Computing GEX from option bars… (30–90 s)' : `📈 Load Historical GEX — ${histDate} ${histTime} ET`}
              </button>

              {histError && !histBarsLoading && histBars.length > 0 && (
                <div style={{ marginTop: 10, padding: '10px 13px', borderRadius: 8,
                  background: C.redDim, border: `1px solid ${C.red}30`,
                  fontSize: 12, color: C.red }}>
                  ✗ {histError}
                </div>
              )}

              {histGex && !histLoading && (
                <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 10,
                  background: C.purpleDim, border: `1px solid ${C.purple}35` }}>
                  <p style={{ margin: '0 0 8px', fontSize: 10, fontWeight: 800,
                    color: C.purple, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                    ✓ GEX Loaded — inputs auto-populated
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 6, fontSize: 11 }}>
                    {[
                      ['Spot',      histGex.spot ? `$${histGex.spot.toFixed(2)}` : '—'],
                      ['Regime',    histGex.regime ?? '—'],
                      ['GEX Flip',  histGex.gamma_flip?.strike ? `$${histGex.gamma_flip.strike}` : '—'],
                      ['Call Wall', histGex.call_wall?.strike  ? `$${histGex.call_wall.strike}`  : '—'],
                      ['Put Wall',  histGex.put_wall?.strike   ? `$${histGex.put_wall.strike}`   : '—'],
                      ['Quotes',    histGex.quote_count ? `${histGex.quote_count} contracts` : '—'],
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between',
                        padding: '5px 8px', borderRadius: 6, background: C.card }}>
                        <span style={{ color: C.inkLight }}>{k}</span>
                        <span style={{ color: C.ink, fontWeight: 700 }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {!result ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 16, overflow: 'hidden' }}>

            {/* Option type */}
            <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.rule}` }}>
              <p style={{ margin: '0 0 12px' }}><Label>Option Type</Label></p>
              <div style={{ display: 'flex', gap: 10 }}>
                <ToggleBtn active={optionType === 'call'} onClick={() => setOptionType('call')}
                  activeColor={C.green} activeBg={C.greenDim}>▲ Call — Bullish</ToggleBtn>
                <ToggleBtn active={optionType === 'put'} onClick={() => setOptionType('put')}
                  activeColor={C.red} activeBg={C.redDim}>▼ Put — Bearish</ToggleBtn>
              </div>
            </div>

            {/* Core prices */}
            <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.rule}` }}>
              <p style={{ margin: '0 0 12px' }}><Label>Core Price Levels</Label></p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <Field label="Current Spot Price" value={spot} onChange={setSpot}
                  placeholder="5520" prefix="$" />
                <Field label="GEX Flip Point" value={gexFlip} onChange={setGexFlip}
                  placeholder="5490" prefix="$"
                  hint='From GEXbot or click "Load from IB" above' />
              </div>
            </div>

            {/* Gamma walls */}
            <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.rule}`,
              background: '#1a1a1a' }}>
              <p style={{ margin: '0 0 4px' }}>
                <Label>Gamma Walls</Label>
                <span style={{ fontSize: 10, color: C.inkLight, marginLeft: 8 }}>optional but highly recommended</span>
              </p>
              <p style={{ margin: '0 0 14px', fontSize: 11, color: C.inkLight, lineHeight: 1.6 }}>
                Call wall = overhead resistance where MMs sell. Put wall = support floor where MMs buy.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="🟢 Call Wall (resistance)" value={callWall} onChange={setCallWall}
                  placeholder="5550" prefix="$"
                  hint="Largest positive GEX strike above spot" />
                <Field label="🔴 Put Wall (support)" value={putWall} onChange={setPutWall}
                  placeholder="5470" prefix="$"
                  hint="Largest negative GEX strike below spot" />
              </div>
            </div>

            {/* P&L inputs */}
            <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.rule}`,
              background: C.blueDim }}>
              <p style={{ margin: '0 0 4px' }}>
                <Label>P&L Calculator</Label>
                <span style={{ fontSize: 10, color: C.inkLight, marginLeft: 8 }}>optional</span>
              </p>
              <p style={{ margin: '0 0 12px', fontSize: 11, color: C.blue }}>
                Enter premium and contracts to see projected dollar gains and reward-to-risk ratio.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Option Premium (per share)" value={premium} onChange={setPremium}
                  placeholder="12.50" prefix="$" />
                <Field label="Number of Contracts" value={contracts} onChange={setContracts}
                  placeholder="1" />
              </div>
              {premium && parseFloat(premium) > 0 && (
                <div style={{ marginTop: 10, padding: '9px 13px', borderRadius: 8,
                  background: C.surface, border: `1px solid ${C.blue}25`,
                  fontSize: 12, color: C.blue, fontWeight: 600 }}>
                  Total outlay: <strong>
                    ${(parseFloat(premium) * 100 * Math.max(1, parseInt(contracts) || 1)).toFixed(2)}
                  </strong>
                </div>
              )}
            </div>

            {/* VIX + Volatility Trigger */}
            <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.rule}`,
              background: C.amberDim }}>
              <p style={{ margin: '0 0 4px' }}>
                <Label>Risk Context</Label>
                <span style={{ fontSize: 10, color: C.inkLight, marginLeft: 8 }}>from GexBot Research</span>
              </p>
              <p style={{ margin: '0 0 14px', fontSize: 11, color: C.amber, lineHeight: 1.6 }}>
                VIX &gt; 30 = do not trade (gamma levels break). Volatility Trigger from "gets spx" in Discord.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="VIX" value={vix} onChange={setVix}
                  placeholder="15.5"
                  hint="Mandatory check: > 30 = stand aside" />
                <Field label="Volatility Trigger" value={volTrigger} onChange={setVolTrigger}
                  placeholder="5490" prefix="$"
                  hint='Above VT = range-bound · Below VT = trending' />
              </div>
              {vix && parseFloat(vix) > 0 && (
                <div style={{ marginTop: 10, padding: '9px 13px', borderRadius: 8,
                  background: parseFloat(vix) > 30 ? C.redDim : parseFloat(vix) > 25 ? C.amberDim : C.greenDim,
                  border: `1px solid ${parseFloat(vix) > 30 ? C.red : parseFloat(vix) > 25 ? C.amber : C.green}25`,
                  fontSize: 12, fontWeight: 600,
                  color: parseFloat(vix) > 30 ? C.red : parseFloat(vix) > 25 ? C.amber : C.green }}>
                  {parseFloat(vix) > 30 ? '🚫 VIX > 30 — Stand aside. Gamma levels unreliable.'
                    : parseFloat(vix) > 25 ? `⚠ VIX ${vix} — Elevated. Reduce position size 30%.`
                    : `✅ VIX ${vix} — Clean conditions. Gamma levels reliable.`}
                </div>
              )}
            </div>

            {/* GEX regime */}
            <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.rule}` }}>
              <p style={{ margin: '0 0 12px' }}><Label>GEX Regime</Label></p>
              <div style={{ display: 'flex', gap: 10 }}>
                <ToggleBtn active={gex === 'positive'} onClick={() => setGex('positive')}
                  activeColor={C.green} activeBg={C.greenDim}>
                  ✦ Positive GEX<br />
                  <span style={{ fontSize: 10, fontWeight: 400 }}>Range-bound · Absorbing</span>
                </ToggleBtn>
                <ToggleBtn active={gex === 'negative'} onClick={() => setGex('negative')}
                  activeColor={C.red} activeBg={C.redDim}>
                  ✦ Negative GEX<br />
                  <span style={{ fontSize: 10, fontWeight: 400 }}>Trending · Amplifying</span>
                </ToggleBtn>
              </div>
            </div>

            {/* IV + Time */}
            <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.rule}` }}>
              <p style={{ margin: '0 0 12px' }}><Label>Context</Label></p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <p style={{ margin: '0 0 6px' }}><Label>IV Rank</Label></p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['low', 'medium', 'high'] as IvRank[]).map(v => (
                      <ToggleBtn key={v} active={ivRank === v} onClick={() => setIvRank(v)}
                        activeColor={C.inkMid} activeBg={C.card}>
                        {v === 'low' ? 'Low' : v === 'medium' ? 'Mid' : 'High'}
                      </ToggleBtn>
                    ))}
                  </div>
                </div>
                <SelectField label="Time of Day" value={timeOfDay} onChange={v => setTimeOfDay(v as TimeSlot)}
                  options={[
                    { value: 'open',      label: '🔔 Open (9:30–10:30)' },
                    { value: 'midday',    label: '😴 Midday (11–2 PM)' },
                    { value: 'powerHour', label: '⚡ Power Hour (2–3)' },
                    { value: 'moc',       label: '🔥 MOC (3–4 PM)' },
                  ]} />
              </div>
            </div>

            {/* Generate */}
            <div style={{ padding: '18px 24px' }}>
              <button onClick={generate} disabled={!ready} style={{
                width: '100%', padding: '14px', borderRadius: 10, border: 'none',
                background: ready ? C.blue : C.card,
                color: ready ? '#fff' : C.inkLight,
                fontSize: 15, fontWeight: 700,
                cursor: ready ? 'pointer' : 'not-allowed', letterSpacing: '0.04em',
                boxShadow: ready ? `0 4px 20px ${C.blue}40` : 'none',
                transition: 'all 0.2s' }}>
                {ready ? 'Generate Strategy →' : 'Enter Spot Price to continue'}
              </button>
            </div>
          </div>

        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Flip warning */}
            {result.nearFlipWarn && (
              <div style={{ background: C.redDim, border: `1px solid ${C.red}30`,
                borderLeft: `4px solid ${C.red}`, borderRadius: 10, padding: '12px 16px',
                display: 'flex', gap: 12 }}>
                <span style={{ fontSize: 18 }}>⚡</span>
                <p style={{ margin: 0, fontSize: 12, color: C.red, lineHeight: 1.7 }}>
                  <strong>Caution:</strong> Spot is within 0.3% of GEX flip at ${result.flipPrice}. Regime unstable — reduce size 50% or wait for a clear directional break.
                </p>
              </div>
            )}

            {/* Sigma range */}
            {result.sigmaLow != null && result.sigmaHigh != null && (
              <div style={{ padding: '11px 16px', borderRadius: 10,
                background: C.purpleDim, border: `1px solid ${C.purple}30`,
                fontSize: 12, color: C.purple, fontWeight: 600,
                display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>📐 1σ Daily Range: ${result.sigmaLow} – ${result.sigmaHigh}</span>
                {(result.spotPrice <= result.sigmaLow || result.spotPrice >= result.sigmaHigh) && (
                  <span style={{ color: C.amber, fontWeight: 700 }}>
                    ⚡ Price at sigma boundary — highest-confluence GexBot setup
                  </span>
                )}
              </div>
            )}

            {/* Pre-trade checklist */}
            <ChecklistCard checklist={result.checklist} vixBlock={result.vixBlock} />

            {/* Level map */}
            {(result.callWall != null || result.putWall != null) && (
              <LevelMap
                spot={result.spotPrice}
                callWall={result.callWall}
                putWall={result.putWall}
                gexFlip={result.gexFlip}
              />
            )}

            {/* Strike recommender */}
            <StrikeCard candidates={result.strikeCandidates} />

            {/* P&L */}
            {premium && parseFloat(premium) > 0 && (
              <PnLCard result={result} premium={premium} contracts={contracts} />
            )}

            {/* 100% Return Range */}
            {result.returnRange && (
              <ReturnRangeCard
                returnRange={result.returnRange}
                optionType={result.optionType}
                spot={result.spotPrice}
                premium={premium}
                contracts={contracts}
              />
            )}

            {/* Main strategy card */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`,
              borderTop: `4px solid ${accentColor}`, borderRadius: 16, overflow: 'hidden' }}>

              <div style={{ background: accentDim, padding: '20px 26px',
                borderBottom: `1px solid ${accentColor}20`,
                display: 'flex', justifyContent: 'space-between',
                alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                    <Tag color={accentColor} bg={`${accentColor}18`}>{result.optionType}</Tag>
                    <Tag color={result.dirColor} bg={`${result.dirColor}12`}>{result.direction}</Tag>
                    <Tag color={result.regimeColor} bg={`${result.regimeColor}12`}>{result.regime}</Tag>
                  </div>
                  <h3 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.ink }}>
                    {result.strategy}
                  </h3>
                </div>
                <RiskDots level={result.risk} />
              </div>

              {/* Strike hero */}
              <div style={{ padding: '18px 26px', borderBottom: `1px solid ${C.rule}`,
                background: C.card, display: 'flex', alignItems: 'center',
                gap: 18, flexWrap: 'wrap' }}>
                <div>
                  <Label>Recommended Strike</Label>
                  <div style={{ fontSize: 30, fontWeight: 700, color: accentColor,
                    letterSpacing: '-0.02em', marginTop: 3 }}>
                    {result.strike.replace('$', '')}
                  </div>
                </div>
                <div style={{ width: 1, height: 44, background: C.border, flexShrink: 0 }} />
                <div>
                  <Label>Structure</Label>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.inkMid, marginTop: 3 }}>
                    Naked directional · Single leg · 0DTE
                  </div>
                  <div style={{ fontSize: 11, color: C.inkLight, marginTop: 2 }}>
                    Consider spread if IV Rank &gt; 60
                  </div>
                </div>
              </div>

              <div style={{ padding: '22px 26px', display: 'flex',
                flexDirection: 'column', gap: 20 }}>

                {/* Why */}
                <div>
                  <Label>Why This Trade Works</Label>
                  <p style={{ margin: '8px 0 0', fontSize: 13, color: C.inkMid, lineHeight: 1.8 }}>
                    {result.why}
                  </p>
                </div>

                {/* Wall context */}
                {(result.wallNote || result.wallSupportNote) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {result.wallNote && (
                      <div style={{ padding: '12px 14px', borderRadius: 10,
                        background: C.greenDim, border: `1px solid ${C.green}25`,
                        fontSize: 12, color: C.green, lineHeight: 1.7 }}>
                        🟢 {result.wallNote}
                      </div>
                    )}
                    {result.wallSupportNote && (
                      <div style={{ padding: '12px 14px', borderRadius: 10,
                        background: C.redDim, border: `1px solid ${C.red}25`,
                        fontSize: 12, color: C.red, lineHeight: 1.7 }}>
                        🔴 {result.wallSupportNote}
                      </div>
                    )}
                  </div>
                )}

                <Divider />

                {/* Trade rows */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {([
                    { label: 'Entry Trigger',    value: result.entry,    accent: C.amber },
                    { label: 'Target 1',          value: result.target1,  accent: C.green },
                    result.zeroGammaPartial != null ? {
                      label: '⚡ Zero Gamma — Mandatory Partial',
                      value: `Take 50% off at $${result.zeroGammaPartial}. Move stop to breakeven. Do not hold the full position past this level.`,
                      accent: C.purple,
                    } : null,
                    { label: 'Target 2 / Wall',   value: result.target2,  accent: C.green },
                    { label: 'Stop Loss',         value: result.stopLoss, accent: C.red },
                    { label: 'IV Note',           value: result.ivNote,   accent: C.amber },
                  ].filter(Boolean) as { label: string; value: string; accent: string }[]).map(({ label, value, accent }) => (
                    <div key={label} style={{ display: 'flex', gap: 14, alignItems: 'flex-start',
                      padding: '12px 14px', borderRadius: 9, background: C.card,
                      border: `1px solid ${C.border}` }}>
                      <div style={{ flexShrink: 0, width: 3, borderRadius: 2,
                        background: accent, alignSelf: 'stretch', minHeight: 12 }} />
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.1em',
                          textTransform: 'uppercase', color: C.inkLight, marginBottom: 3 }}>{label}</div>
                        <div style={{ fontSize: 12, color: C.ink, lineHeight: 1.6 }}>{value}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <Divider />

                {/* Time window */}
                <div style={{ padding: '14px 16px', borderRadius: 11,
                  background: C.amberDim, border: `1px solid ${C.amber}30` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                    <Label>⏱ {result.timeInfo.label}</Label>
                    <RiskDots level={result.timeInfo.risk} />
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: C.amber, lineHeight: 1.7 }}>
                    {result.timeInfo.note}
                  </p>
                </div>

                <Divider />

                {/* Rules */}
                <div>
                  <Label>Trade Rules</Label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 10 }}>
                    {result.rules.map((r, i) => (
                      <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <span style={{ flexShrink: 0, width: 20, height: 20,
                          borderRadius: '50%', background: C.card,
                          border: `1.5px solid ${C.border}`, color: C.inkMid,
                          fontSize: 10, fontWeight: 700,
                          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {i + 1}
                        </span>
                        <span style={{ fontSize: 12, color: C.inkMid, lineHeight: 1.6, paddingTop: 1 }}>
                          {r}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* P&L nudge */}
            {(!premium || parseFloat(premium) <= 0) && (
              <div style={{ background: C.blueDim, border: `1px solid ${C.blue}25`,
                borderRadius: 12, padding: '14px 18px',
                display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 18 }}>📊</span>
                <p style={{ margin: 0, fontSize: 12, color: C.blue, lineHeight: 1.6 }}>
                  <strong>No P&L shown.</strong> Go back and enter your option premium + contracts to see projected dollar gains and reward-to-risk ratio.
                </p>
              </div>
            )}

            {/* Survival rules */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 13, padding: '18px 22px' }}>
              <Label>Universal 0DTE Survival Rules</Label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                {[
                  ['🕒', 'Exit by 3:30 PM always'],
                  ['💰', 'Take 50% profit, then trail'],
                  ['🛑', 'Hard stop: 45% loss on option'],
                  ['📦', 'Max 1–2% of account per trade'],
                  ['🚫', 'No trading around FOMC / CPI'],
                  ['👁', 'Watch GEX flip live mid-session'],
                  ['🟢', 'Call wall = ceiling, not a goal'],
                  ['🔴', 'Put wall = floor, not a breakdown'],
                ].map(([icon, text]) => (
                  <div key={text} style={{ display: 'flex', gap: 9, alignItems: 'center',
                    padding: '9px 12px', borderRadius: 7,
                    background: C.card, border: `1px solid ${C.border}` }}>
                    <span style={{ fontSize: 14, flexShrink: 0 }}>{icon}</span>
                    <span style={{ fontSize: 11, color: C.inkMid, lineHeight: 1.4 }}>{text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Back button */}
            <button onClick={reset} style={{ width: '100%', padding: '13px',
              borderRadius: 10, border: `1.5px solid ${C.border}`,
              background: C.surface, color: C.inkMid,
              fontSize: 14, fontWeight: 600,
              cursor: 'pointer' }}>
              {histMode ? '← Change Date / Time' : '← New Setup'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
