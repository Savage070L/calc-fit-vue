/**
 * Расчёт индексации полиса — Pro Life Fit
 *
 * Эталон: «Копия 260226 PRO Life FIT индексация NBS.xlsm» (макрос
 * Final_Stable_Macro_HiddenSheet, листы «Данные i», «Параметры i», «Расчет i»).
 *
 * Модель эталона — «доплата за прирост СС с накопленным резервом Vx_m»
 * (та же, что в Saqtau Senim; подтверждена до тенге на закэшированном прогоне
 * макроса: 20 годовщин, n=20, monthly, индексация 6 %):
 *
 *   ─── кривые ИСХОДНОГО полиса (k = 0..n, исходный возраст x, исходные n и t) ──
 *   A(k)  = (M(x+k) − M(x+n) + D(x+n)) / D(x+k)        // Ax:n на год k («Расчет i» E18+)
 *   aN(k) = (N(x+k) − N(x+n)) / D(x+k)                 // ax:n на год k (F18+)
 *   aT(k) = (N(x+k) − N(x+t)) / D(x+k)                 // ax:t на год k (G18+); t = n при
 *                                                      // рассрочке (⇒ aT = aN), t = 1 при single
 *
 *   ─── состояние годовщины m (m = 0..n−1) ────────────────────────────────────
 *   SA_m = SA_0 × (1 + i)^m
 *   G2_m = 0 при m ≥ 1; G3_m = 0 при m ≥ 2 (аквизиция списана)
 *   F1 = A(m); F2 = aN(m)            // верхний блок «Расчет i» (x_iz = x+m даёт те же значения)
 *   F3 = aN(m) при рассрочке         // B9 = N(x+t) с ИСХОДНЫМИ x и t ⇒ ax:t = ax:n
 *      = 1      при single
 *   BP_m = (F1 + G7×F2) / (F3 − G6×F3 − (G2_m + G3_m × D(x+1)/D(x+m)))   // «Расчет i»!F7
 *   F9_m = ROUND(Vx_m / (F1 + G7×F2))                                    // «Расчет i»!F9
 *   премия_m = ROUND(BP_m × (SA_m − F9_m) × коэф.периодичности)          // «Расчет i»!F8
 *
 *   ─── накопление резерва («Данные i» E54+ → «Расчет i» I/J(18+m+1), счит. в состоянии m) ──
 *   alfa = G3_m при k = m+1 = 1, иначе 0                                 // «Расчет i» H19+
 *   Irate = A(k) + G7×aN(k) − BP_m × (aT(k)×(1−G6) − alfa)               // I(18+k)
 *   Vx_{m+1} = ROUND(Irate × (SA_m − F9_m) + F9_m × A(k)),  k = m+1      // I×(C15−F9)+J
 *   Vx_0 = 0
 *
 * ВАЖНО: Vx_m в FIT может быть ОТРИЦАТЕЛЬНЫМ в первые годы (аквизиционная
 * нагрузка больше резерва — в эталоне J54 = −66 570) — рекурсия использует
 * сырое значение, клампится только отображаемый резерв.
 *
 * Отличия от Senim: ставка фиксированная 5 % (одна таблица коммутаций),
 * G6 = 0.05 и G7 = 0.003 — константы (config.expenses), G2/G3 — из таблицы
 * expenseAv по сроку уплаты t (как в PolicyCalculator._getExpenses).
 */

import { PolicyCalculator, roundHalfUp } from './calculator.js';
import { PRODUCT_CONFIG }                from '../config/product.js';

/**
 * Сырые G2/G3 (до обнуления по годовщинам) — копия логики
 * PolicyCalculator._getExpenses для срока уплаты t.
 */
function getRawG2G3(config, t, isSingle) {
  const e = config.expenses;
  if (isSingle) return { G2: e.expenseSingle, G3: 0 };
  let idx;
  if (t >= 10) idx = Math.min(t - 9, 4);
  else         idx = Math.min(Math.max(t - 2, 1), 4);
  const av = e.expenseAv[idx] ?? { K: 0.65, L: 0.305 };
  return { G2: av.K, G3: av.L };
}

// SA-linked рейдеры FIT (сумма = СС основного, растёт с индексацией)
const SA_LINKED_KEYS = ['accidental_death', 'disability_accident_lumpsum'];
// Fixed-sum рейдеры: сумма выбрана пользователем, НЕ индексируется
const FIXED_SUM_KEYS = ['bodily_injury', 'temporary_disability', 'hospitalization', 'bodily_injury_extra'];

/**
 * Рассчитать таблицу индексации.
 *
 * @param {Object} params — { dob, gender, term, frequency, initialSumAssured,
 *   indexRate (0..1), baseDate?, engine, config?, ridersSelection?, ridersCalc? }
 * @returns {Array<{year, date, dateEnd, age, remainingTerm, sumAssured,
 *   mainPremium, ridersPremium, premium, BP_rate, G2, G3, G6, G7,
 *   reserve, surrender, reducedSA}>}
 */
export function calculateIndexationSchedule(params) {
  const {
    dob, gender, term, frequency = 'annual',
    initialSumAssured, indexRate,
    baseDate = new Date(),
    engine, config = PRODUCT_CONFIG,
    ridersSelection = null,
    ridersCalc      = null,
  } = params;

  if (!engine) throw new Error('calculateIndexationSchedule: engine is required');
  if (!dob || !gender || !term || !initialSumAssured) return [];
  if (indexRate < 0 || indexRate > 1) return [];

  const isSingle   = frequency === 'single';
  const baseAge    = PolicyCalculator.calculateAge(dob);
  const freqAdj    = config.frequencyAdjustment ?? {};
  const freqFactor = isSingle ? 1.0 : (freqAdj[frequency] ?? 1.0);
  const surrenderPenalty = config.surrenderPenalty;

  // FIT: ставка фиксированная 5 % — одна таблица коммутаций на весь прогон
  const comm = engine.getCommutationTable(gender);

  const D = a => comm.Dx(a);
  const N = a => comm.Nx(a);
  const M = a => comm.Mx(a);

  // Константы исходного полиса
  const Dxn  = D(baseAge + term);                          // D(x+n)
  const Nxn  = N(baseAge + term);                          // N(x+n)
  const Mxn  = M(baseAge + term);                          // M(x+n)
  const NxtO = N(baseAge + (isSingle ? 1 : term));         // B9 = N(x+t), исходные x и t

  // Кривые исходного полиса на год k (эталон: «Расчет i», строки 18+, возраст x+k)
  const A_  = k => { const d = D(baseAge + k); return d > 0 ? (M(baseAge + k) - Mxn + Dxn) / d : 0; };
  const aN_ = k => { const d = D(baseAge + k); return d > 0 ? (N(baseAge + k) - Nxn) / d : 0; };
  // Для single t=1 ⇒ (N(x+k) − N(x+1))/D < 0 при k ≥ 2 — в эталоне вырождено;
  // актуарно корректно 0 (после года 0 взносов нет), поэтому clamp. При рассрочке
  // t = n ⇒ NxtO = Nxn и clamp никогда не срабатывает (aT = aN ≥ 0).
  const aT_ = k => { const d = D(baseAge + k); return d > 0 ? Math.max(0, (N(baseAge + k) - NxtO) / d) : 0; };

  // Нагрузки FIT: G6/G7 — константы; G2/G3 — по исходному сроку уплаты t,
  // с обнулением по годовщинам (G2 при m ≥ 1, G3 при m ≥ 2 — «Параметры i» F2/F3)
  const G6 = config.expenses.G6;
  const G7 = config.expenses.G7;
  const rawG2G3 = getRawG2G3(config, isSingle ? 1 : term, isSingle);

  const rows = [];
  // Срок индексации фиксированный: term − 1 (год 0 = базовый, до года term−1 включительно)
  const maxM = term - 1;

  // ── Константная часть рейдеров ──────────────────────────────────────────
  // Эталон («Данные» AB7+ = $F$27+$F$29+$F$31+$F$33+$F$41 + 'Данные i'!H):
  // fixed-sum рейдеры и КЗ в клиентском графике НЕ пересчитываются по
  // годовщинам — берутся премии на дату выпуска. Пересчитываются только
  // основное покрытие, SA-linked рейдеры и waiver (они в составе H).
  let fixedRidersPremium0 = 0;
  if (ridersSelection && ridersCalc) {
    const t0 = isSingle ? 1 : term;
    for (const rk of FIXED_SUM_KEYS) {
      const sel = ridersSelection[rk];
      if (sel?.enabled && (sel.sum ?? 0) > 0) {
        fixedRidersPremium0 += ridersCalc.calculateSimpleRider(rk, sel.sum, term, frequency).riderPremium;
      }
    }
    const ciSel = ridersSelection.critical_illness;
    if (ciSel?.enabled && (ciSel.sum ?? 0) > 0) {
      fixedRidersPremium0 += ridersCalc.calculateCIRider(baseAge, term, t0, gender, ciSel.sum, frequency).riderPremium;
    }
  }

  let Vx = 0;  // накопленный резерв Vx_m («Данные i»!J7); Vx_0 = 0 (E53 = 0)

  for (let m = 0; m <= maxM; m++) {
    const ageM          = baseAge + m;
    const remainingTerm = term - m;
    if (remainingTerm < 1) break;
    // Возрастной cut-off (FIT: возраст на конец договора ≤ 69)
    if (ageM + remainingTerm > (config.maxExitAge ?? 69)) break;

    // Индексированная страховая сумма («Данные i»!C15 = I7 = G7 × (1 + ставка))
    const saM = initialSumAssured * Math.pow(1 + indexRate, m);

    const G2 = m >= 1 ? 0 : rawG2G3.G2;
    const G3 = m >= 2 ? 0 : rawG2G3.G3;

    // Верхний блок «Расчет i»: при x_iz = x+m значения совпадают с кривыми года m
    const Dx = D(ageM);
    const F1 = A_(m);                                      // Ax:n
    const F2 = aN_(m);                                     // ax:n
    const F3 = isSingle
      ? (Dx > 0 ? (N(ageM) - N(ageM + 1)) / Dx : 0)        // = 1 (рента на 1 платёж)
      : F2;                                                // B9 = N(x+t) исходные ⇒ ax:t = ax:n

    // Брутто-ставка года m («Расчет i»!F7). В alfa-части — B2/B1 = D(x+1)/D(x_iz)
    const den = F3 - G6 * F3 - (G2 + G3 * D(baseAge + 1) / Dx);
    const BP  = den > 0 ? (F1 + G7 * F2) / den : 0;

    // F9 — «оплаченная» резервом часть СС («Расчет i»!F9); Vx может быть < 0
    const denF9 = F1 + G7 * F2;
    const F9 = m > 0 && denF9 > 0 ? roundHalfUp(Vx / denF9) : 0;

    // Премия основного покрытия года m — ДОПЛАТА за прирост СС («Расчет i»!F8)
    const mainPremium = roundHalfUp(BP * (saM - F9) * freqFactor);

    // ── Премии включённых рейдеров ──────────────────────────────────────
    // SA-linked — на saM (в составе «Данные i»!H); waiver — актуарно
    // (тоже в H). Fixed-sum и КЗ — константы выпуска (fixedRidersPremium0).
    let ridersPremium = fixedRidersPremium0;
    if (ridersSelection && ridersCalc) {
      const tCur = isSingle ? 1 : remainingTerm;
      for (const rk of SA_LINKED_KEYS) {
        if (ridersSelection[rk]?.enabled) {
          ridersPremium += ridersCalc.calculateSimpleRider(rk, saM, remainingTerm, frequency).riderPremium;
        }
      }
      if (ridersSelection.premium_waiver?.enabled) {
        ridersPremium += ridersCalc.calculateWaiverRider(ageM, remainingTerm, tCur, gender, saM, BP, frequency).riderPremium;
      }
    }
    const premium = mainPremium + ridersPremium;

    // ── Накопление резерва: Vx на годовщину m+1, посчитанный в состоянии m ──
    const k     = m + 1;
    const alfa  = k === 1 ? G3 : 0;                        // H19 = G3 (G4 = G5 = 0); H20+ = 0
    const Ak    = A_(k);
    const Irate = Ak + G7 * aN_(k) - BP * (aT_(k) * (1 - G6) - alfa);
    const VxNext = roundHalfUp(Irate * (saM - F9) + F9 * Ak);

    // Резерв/выкупная на конец года m (= годовщина m+1) — эталонные колонки K/L/M
    const Lrate = Irate - (1 - Irate) * surrenderPenalty;
    const Jres  = F9 * Ak;
    const Kres  = Jres - (F9 - Jres) * surrenderPenalty;
    const reserve   = Math.max(VxNext, 0);
    const surrender = remainingTerm === 1
      ? saM   // дожитие
      : Math.max(roundHalfUp(Math.max(Lrate, 0) * (saM - F9) + Kres), 0);
    const reducedSA = Ak > 0 ? roundHalfUp(surrender / Ak) : 0;

    // Даты годовщин: baseDate + m лет
    const date = new Date(baseDate.getTime());
    date.setFullYear(date.getFullYear() + m);
    const dateEnd = new Date(date.getTime());
    dateEnd.setFullYear(dateEnd.getFullYear() + 1);

    rows.push({
      year:           m,
      date:           date.toISOString().slice(0, 10),
      dateEnd:        dateEnd.toISOString().slice(0, 10),
      age:            ageM,
      remainingTerm,
      sumAssured:     Math.round(saM * 100) / 100,
      mainPremium,
      ridersPremium,
      premium,
      BP_rate:        BP,
      G2, G3, G6, G7,
      reserve:        Math.round(reserve   * 100) / 100,
      surrender:      Math.round(surrender * 100) / 100,
      reducedSA,
    });

    Vx = VxNext;
  }

  return rows;
}
