/**
 * Калькулятор полиса — Pro Life Fit
 *
 * Основные формулы (single-decrement endowment):
 *   Ax:n  = (M(x) − M(x+n) + D(x+n)) / D(x)
 *   ax:n  = (N(x) − N(x+n)) / D(x)
 *   ax:t  = (N(x) − N(x+t)) / D(x)
 *   NP    = Ax:n / ax:t
 *   BP    = (Ax:n + G7×ax:n) / (ax:t − G6×ax:t − (G2 + G3×D(x+1)/D(x)))
 *
 * Особенности FIT:
 *   • Одна формула брутто-премии (нет варианта paid_premiums и формул IAx:n).
 *   • Нагрузки G2/G3 берутся из таблицы expenseAv по индексу min(t-9, 4).
 *     При t = 1 (единовременно): G2 = expenseSingle (K5), G3 = 0.
 *   • G6 = 5%, G7 = 0.3%, G8 = 1%, G9 = 1% (нагрузка на аннуитет).
 *   • Бонусов нет — только резервы и выкупные суммы.
 */

import { ActuarialEngine } from './actuarial.js';
import { PRODUCT_CONFIG }  from '../config/product.js';

// ─── Вспомогательное округление (ROUND_HALF_UP, как в Excel) ─────────────────

export function roundHalfUp(value, decimals = 0) {
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

// ─── PolicyCalculator ─────────────────────────────────────────────────────────

export class PolicyCalculator {

  constructor(engine, config = PRODUCT_CONFIG) {
    this.engine           = engine;
    this.config           = config;
    this.expenses         = config.expenses;
    this.freqAdj          = config.frequencyAdjustment;
    this.surrenderPenalty = config.surrenderPenalty;
    this.annuityExpense   = config.annuityExpense;
  }

  // ─── Утилиты ────────────────────────────────────────────────────────────────

  /**
   * Вычислить полный возраст на дату ref (по умолчанию — сегодня).
   * @param {string} dob — дата рождения 'YYYY-MM-DD'
   * @param {Date}   [ref]
   */
  static calculateAge(dob, ref = new Date()) {
    const [y, m, d] = dob.split('-').map(Number);
    let age = ref.getFullYear() - y;
    if (ref.getMonth() + 1 < m || (ref.getMonth() + 1 === m && ref.getDate() < d)) {
      age -= 1;
    }
    return age;
  }

  _freqFactor(frequency) {
    return this.freqAdj[frequency] ?? 1.0;
  }

  /**
   * Нагрузки FIT для срока уплаты взносов t.
   *
   * Excel:
   *   G2 = IF(t=1, K5, INDEX(K1:L4, MIN(t-9, 4), 1))
   *   G3 = IF(t=1, 0,  INDEX(K1:L4, MIN(t-9, 4), 2))
   *
   * При t < 10 (вне основного диапазона FIT) — fallback на ближайший индекс.
   */
  _getExpenses(t) {
    const e = this.expenses;
    const G6 = e.G6, G7 = e.G7, G8 = e.G8, G9 = e.G9;

    if (t === 1) {
      return { G2: e.expenseSingle, G3: 0.0, G6, G7, G8, G9 };
    }
    let idx;
    if (t >= 10) {
      idx = Math.min(t - 9, 4);
    } else {
      idx = Math.min(Math.max(t - 2, 1), 4);
    }
    const av = e.expenseAv[idx] ?? { K: 0.65, L: 0.305 };
    return { G2: av.K, G3: av.L, G6, G7, G8, G9 };
  }

  // ─── Актуарные значения ──────────────────────────────────────────────────────

  /**
   * Вычислить основные актуарные величины для возраста x, срока n, периода взносов t.
   */
  _actuarialValues(comm, x, n, t) {
    const Dx  = comm.Dx(x);
    const Dxn = comm.Dx(x + n);
    const Dx1 = comm.Dx(x + 1);
    const Mx  = comm.Mx(x);
    const Mxn = comm.Mx(x + n);
    const Nx  = comm.Nx(x);
    const Nxn = comm.Nx(x + n);
    const Nxt = comm.Nx(x + t);

    const Ax_n = Dx > 0 ? (Mx - Mxn + Dxn) / Dx : 0.0;
    const ax_n = Dx > 0 ? (Nx - Nxn) / Dx       : 0.0;
    const ax_t = Dx > 0 ? (Nx - Nxt) / Dx       : 0.0;

    const NP = ax_t > 0 ? Ax_n / ax_t : 0.0;

    return { Dx, Dxn, Dx1, Mx, Mxn, Nx, Nxn, Nxt, Ax_n, ax_n, ax_t, NP };
  }

  // ─── Брутто-ставка ───────────────────────────────────────────────────────────

  /**
   * Рассчитать брутто-ставку BP на 1 единицу СС.
   *   BP = (Ax:n + G7×ax:n) / (ax:t − G6×ax:t − (G2 + G3×D(x+1)/D(x)))
   */
  calcGrossPremiumRate(x, n, t, gender, kMult = 1.0, lAdd = 0.0) {
    const comm     = this.engine.getCommutationTable(gender, kMult, lAdd);
    const vals     = this._actuarialValues(comm, x, n, t);
    const expenses = this._getExpenses(t);

    const { G2, G3, G6, G7 } = expenses;
    const { Ax_n, ax_n, ax_t, Dx, Dx1 } = vals;

    const numerator   = Ax_n + G7 * ax_n;
    const denominator = ax_t - G6 * ax_t - (G2 + G3 * Dx1 / Dx);
    let BP = denominator > 0 ? numerator / denominator : 0.0;
    BP = Math.round(BP * 1e14) / 1e14;  // патч из batch_calculation_fixed2.py

    return { ...vals, ...expenses, BP, NP: vals.NP,
             interestRate: this.engine.getInterestRate() };
  }

  // ─── Расчёт премии по заданной СС ────────────────────────────────────────────

  calculatePremium(dob, gender, term, frequency, sumAssured, kMult = 1.0, lAdd = 0.0) {
    const x    = PolicyCalculator.calculateAge(dob);
    const t    = frequency === 'single' ? 1 : term;
    const vals = this.calcGrossPremiumRate(x, term, t, gender, kMult, lAdd);

    const { BP, NP, interestRate } = vals;
    const freqFactor = this._freqFactor(frequency);

    let annualPremium, grossPremium;
    if (frequency === 'single') {
      grossPremium  = roundHalfUp(BP * sumAssured);
      annualPremium = grossPremium;
    } else {
      annualPremium = roundHalfUp(BP * sumAssured);
      grossPremium  = roundHalfUp(BP * sumAssured * freqFactor);
    }

    return {
      age: x, term, paymentTerm: t, gender, frequency,
      sumAssured, interestRate,
      BP_rate: BP, NP_rate: NP,
      annualPremium, grossPremium,
      netPremium: NP * sumAssured,
      freqFactor,
      actuarial: vals,
    };
  }

  // ─── Расчёт СС по заданной премии ────────────────────────────────────────────

  calculateSumAssured(dob, gender, term, frequency, premium, kMult = 1.0, lAdd = 0.0) {
    const x    = PolicyCalculator.calculateAge(dob);
    const t    = frequency === 'single' ? 1 : term;
    const vals = this.calcGrossPremiumRate(x, term, t, gender, kMult, lAdd);

    const { BP, NP, interestRate } = vals;
    const freqFactor = this._freqFactor(frequency);

    let sumAssured;
    if (frequency === 'single') {
      sumAssured = BP > 0 ? premium / BP : 0.0;
    } else {
      sumAssured = BP > 0 ? premium / (BP * freqFactor) : 0.0;
    }
    sumAssured = Math.round(sumAssured * 100) / 100;

    const annualPremium = roundHalfUp(BP * sumAssured);
    const grossPremium  = frequency === 'single'
      ? annualPremium
      : roundHalfUp(BP * sumAssured * freqFactor);

    return {
      age: x, term, paymentTerm: t, gender, frequency,
      sumAssured, interestRate,
      BP_rate: BP, NP_rate: NP,
      annualPremium, grossPremium,
      netPremium: NP * sumAssured,
      freqFactor,
      actuarial: vals,
    };
  }

  // ─── Обратный расчёт с учётом райдеров (3-фазный солвер) ────────────────────

  calculateSumAssuredWithRiders(dob, gender, term, frequency, totalPremium,
                                ridersCalc, saLinkedKeys, fixedRiders,
                                hasWaiver = false,
                                kMult = 1.0, lAdd = 0.0) {
    if (!totalPremium || !term) {
      return this.calculateSumAssured(dob, gender, term, frequency, 0, kMult, lAdd);
    }

    const x    = PolicyCalculator.calculateAge(dob);
    const t    = frequency === 'single' ? 1 : term;
    const vals = this.calcGrossPremiumRate(x, term, t, gender, kMult, lAdd);
    const { BP: bpRate, NP, interestRate } = vals;

    if (!bpRate) {
      return this.calculateSumAssured(dob, gender, term, frequency, 0, kMult, lAdd);
    }

    const freqFactor = this._freqFactor(frequency);

    // Суммарный тариф SA-linked допов
    let saLinkedTariffSum = 0.0;
    for (const rk of saLinkedKeys) {
      saLinkedTariffSum += this._getSimpleRiderGrossTariff(rk);
    }

    // Тариф waiver: J6 = ROUND( disability.tariff × (1+exp) / (1−acq), 4 )
    const j6 = (() => {
      const rcDis = this.config.riders?.disability_accident_lumpsum ?? {};
      const bt = rcDis.tariff ?? 0.0;
      return roundHalfUp(bt * (1.0 + (rcDis.expenses ?? 0)) / (1.0 - (rcDis.acquisition ?? 0)), 4);
    })();
    const waiverActive = hasWaiver && frequency !== 'single' && t > 1 && term > 1;

    // Фиксированная часть (fixed-sum допы) — не зависят от SA
    let fixedTotal = 0.0;
    for (const [rk, rs] of fixedRiders) {
      const riderSum = parseFloat(rs);
      if (riderSum > 0) {
        if (rk === 'critical_illness') {
          const r = ridersCalc.calculateCIRider(x, term, t, gender, riderSum, frequency);
          fixedTotal += r.riderPremium;
        } else {
          const r = ridersCalc.calculateSimpleRider(rk, riderSum, term, frequency);
          fixedTotal += r.riderPremium;
        }
      }
    }

    // Премия waiver (зависит от SA)
    const waiverPremium = (sa) => {
      if (!waiverActive) return 0;
      const annualPayment = roundHalfUp(bpRate * sa);
      let rSum = 0.0;
      for (let k = 0; k < term - 1; k++) {
        const remaining = term - 1 - k;
        rSum += roundHalfUp(remaining * annualPayment * j6);
      }
      return roundHalfUp((rSum / (term - 1)) * freqFactor);
    };

    const tpSmooth = (sa) => {
      const sac  = roundHalfUp(sa);
      const main = frequency === 'single'
        ? bpRate * sac
        : bpRate * sac * freqFactor;
      let linked = 0;
      for (const rk of saLinkedKeys) {
        linked += ridersCalc.calculateSimpleRider(rk, sac, term, frequency).riderPremium;
      }
      return main + linked + fixedTotal + waiverPremium(sac);
    };

    const tpRound = (sa) => {
      const sac  = roundHalfUp(sa);
      const main = frequency === 'single'
        ? roundHalfUp(bpRate * sac)
        : roundHalfUp(bpRate * sac * freqFactor);
      let linked = 0;
      for (const rk of saLinkedKeys) {
        linked += ridersCalc.calculateSimpleRider(rk, sac, term, frequency).riderPremium;
      }
      return main + linked + fixedTotal + waiverPremium(sac);
    };

    // Фаза 1: Бинарный поиск
    let saEst = frequency === 'single'
      ? totalPremium / bpRate * 2
      : totalPremium / (bpRate * freqFactor) * 2;

    let saLo = 0.0, saHi = saEst;
    while (tpSmooth(saHi) < totalPremium) {
      saHi *= 2;
      if (saHi > 1e15) break;
    }
    for (let iter = 0; iter < 300; iter++) {
      const mid = (saLo + saHi) / 2;
      if (tpSmooth(mid) < totalPremium) saLo = mid; else saHi = mid;
      if (saHi - saLo < 1e-6) break;
    }
    const saSmooth = (saLo + saHi) / 2;

    // Фаза 2: Аналитическое решение
    const pwMult = waiverActive ? (j6 * term / 2.0) : 0.0;
    const totalRate = waiverActive
      ? (bpRate * (1.0 + pwMult) + saLinkedTariffSum) * freqFactor
      : (bpRate + saLinkedTariffSum) * (frequency === 'single' ? 1.0 : freqFactor);
    const saCont = totalRate > 0 ? (totalPremium - fixedTotal) / totalRate : saSmooth;

    // Фаза 3: Refinement — перебор ближайших кандидатов
    let bestSA   = saSmooth;
    let bestDiff = Math.abs(tpRound(saSmooth) - totalPremium);

    const candidates = [];
    for (let off = -5; off <= 5; off++) candidates.push(Math.round(saSmooth) + off);
    for (const d of [-0.5, -0.25, -0.1, -0.01, 0, 0.01, 0.1, 0.25, 0.5]) candidates.push(saSmooth + d);
    candidates.push(saCont);
    for (let off = -5; off <= 5; off++) candidates.push(Math.round(saCont) + off);
    for (const d of [-0.5, -0.25, -0.1, -0.01, 0, 0.01, 0.1, 0.25, 0.5]) candidates.push(saCont + d);

    for (const sa of candidates) {
      if (sa <= 0) continue;
      const diff = Math.abs(tpRound(sa) - totalPremium);
      if (diff < bestDiff) { bestDiff = diff; bestSA = sa; }
    }

    const sumAssured    = Math.round(bestSA * 100) / 100;
    const annualPremium = roundHalfUp(bpRate * sumAssured);
    const grossPremium  = frequency === 'single'
      ? annualPremium
      : roundHalfUp(bpRate * sumAssured * freqFactor);

    return {
      age: x, term, paymentTerm: t, gender, frequency,
      sumAssured, interestRate,
      BP_rate: bpRate, NP_rate: NP,
      annualPremium, grossPremium,
      netPremium: NP * sumAssured,
      freqFactor,
      actuarial: vals,
    };
  }

  _getSimpleRiderGrossTariff(riderKey) {
    const rc = this.config.riders?.[riderKey] ?? {};
    const bt = rc.tariff ?? 0.0;
    return roundHalfUp(bt * (1.0 + (rc.expenses ?? 0)) / (1.0 - (rc.acquisition ?? 0)), 4);
  }

  // ─── Таблица резервов ─────────────────────────────────────────────────────────

  /**
   * Рассчитать резервы и выкупные суммы по годам.
   *
   * Формула резерва (year k):
   *   Ax:n_k = (M(x+k) − M(x+n) + D(x+n)) / D(x+k)
   *   ax:n_k = (N(x+k) − N(x+n)) / D(x+k)
   *   ax:t_k = (N(x+k) − N(x+t)) / D(x+k)   при k < t, иначе 0
   *   alpha_k = G3 при k = 1, иначе 0
   *
   *   reserve_rate  = Ax:n_k + G7×ax:n_k − BP×(ax:t_k − G6×ax:t_k − alpha_k)
   *   surrender_rate = reserve_rate − (1 − reserve_rate) × G8
   *   reserve   = reserve_rate × SA
   *   surrender = max(surrender_rate × SA, 0); при k = n → SA (дожитие)
   *   reduced_SA = ROUND(surrender / Ax:n_k, 0)
   */
  calculateReserves(dob, gender, term, frequency, sumAssured, kMult = 1.0, lAdd = 0.0) {
    const x    = PolicyCalculator.calculateAge(dob);
    const t    = frequency === 'single' ? 1 : term;
    const comm = this.engine.getCommutationTable(gender, kMult, lAdd);

    const base     = this._actuarialValues(comm, x, term, t);
    const expenses = this._getExpenses(t);
    const { G2, G3, G6, G7, G8 } = expenses;

    const numerator   = base.Ax_n + G7 * base.ax_n;
    const denominator = base.ax_t - G6 * base.ax_t - (G2 + G3 * base.Dx1 / base.Dx);
    const BP = denominator > 0 ? numerator / denominator : 0.0;

    const Mxn = comm.Mx(x + term);
    const Dxn = comm.Dx(x + term);
    const Nxn = comm.Nx(x + term);
    const Nxt = comm.Nx(x + t);

    const reserves = [];

    for (let k = 1; k <= term; k++) {
      const xk  = x + k;
      const Dxk = comm.Dx(xk);

      if (Dxk === 0) {
        reserves.push({ year: k, age: xk, reserveRate: 0, surrenderRate: 0,
                        reserve: 0, surrender: 0, reducedSA: 0 });
        continue;
      }

      const Mxk = comm.Mx(xk);
      const Nxk = comm.Nx(xk);

      const Ax_n_k = (Mxk - Mxn + Dxn) / Dxk;
      const ax_n_k = (Nxk - Nxn) / Dxk;
      const ax_t_k = k < t ? (Nxk - Nxt) / Dxk : 0.0;

      // Остаточная аквизиционная нагрузка (FIT): G3 на 1-м году, иначе 0
      const alpha_k = (k === 1 && t > 1) ? G3 : 0.0;

      const reserveRate   = Ax_n_k + G7 * ax_n_k - BP * (ax_t_k - G6 * ax_t_k - alpha_k);
      const surrenderRate = reserveRate - (1.0 - reserveRate) * G8;

      const reserve  = reserveRate * sumAssured;
      let surrender  = Math.max(surrenderRate * sumAssured, 0.0);
      if (k === term) surrender = sumAssured;

      const reducedSA = Ax_n_k > 0 ? roundHalfUp(surrender / Ax_n_k) : 0;

      reserves.push({
        year: k, age: xk,
        Ax_n_k, ax_n_k, ax_t_k, alpha_k,
        reserveRate, surrenderRate,
        reserve:   Math.round(reserve * 100) / 100,
        surrender: Math.round(surrender * 100) / 100,
        reducedSA,
      });
    }

    return reserves;
  }

  // ─── Аннуитет ─────────────────────────────────────────────────────────────────

  /**
   * Рассчитать аннуитетные выплаты.
   *
   * Factor = ((1 − v_m^(gp×m)) / (v_m × d_m)
   *           + m × ((N(x+n+gp) − N(x+n+n_ann)) / D(x+n)
   *                  − (m−1)/(2m) × (1 − D(x+n+n_ann)/D(x+n)))
   *          ) × (1 + δ)
   *
   * Аннуитет = ROUND(SA / Factor, 0).
   * δ = G9, кроме (n_ann = 1 ∧ m = 1) — тогда δ = 0.
   */
  calculateAnnuity(x, n, sumAssured, annuityFrequency = 'annual', annuityTerm = 0,
                   guaranteedPeriod = 0, gender = 'male', kMult = 1.0, lAdd = 0.0) {
    if (annuityTerm <= 0) {
      return { annuityPayment: 0, annuityFactor: 0,
               annuityFrequency, annuityTerm, guaranteedPeriod };
    }

    const i  = this.engine.getInterestRate();
    const freqMap = { annual: 1, semiannual: 2, quarterly: 4, monthly: 12 };
    const m  = freqMap[annuityFrequency] ?? 1;

    const d_m = Math.pow(1.0 + i, 1.0 / m) - 1.0;
    const v_m = d_m > -1.0 ? 1.0 / (1.0 + d_m) : 0.0;

    const comm = this.engine.getCommutationTable(gender, kMult, lAdd);
    const Dxn  = comm.Dx(x + n);

    if (Dxn === 0 || d_m <= 0) {
      return { annuityPayment: 0, annuityFactor: 0,
               annuityFrequency, annuityTerm, guaranteedPeriod };
    }

    const gp   = guaranteedPeriod;
    const nAnn = annuityTerm;

    const guaranteedPart = (gp > 0)
      ? (1.0 - Math.pow(v_m, gp * m)) / (v_m * d_m)
      : 0.0;

    const Nxn_gp  = comm.Nx(x + n + gp);
    const Nxn_ann = comm.Nx(x + n + nAnn);
    const Dxn_ann = comm.Dx(x + n + nAnn);

    const lifePart = m * (
      (Nxn_gp - Nxn_ann) / Dxn
      - ((m - 1.0) / (2.0 * m)) * (1.0 - Dxn_ann / Dxn)
    );

    const addExpense = (nAnn === 1 && m === 1) ? 0.0 : this.annuityExpense;
    const aFactor   = (guaranteedPart + lifePart) * (1.0 + addExpense);
    const annuityPayment = aFactor > 0 ? roundHalfUp(sumAssured / aFactor) : 0;

    return {
      annuityPayment, annuityFactor: aFactor,
      annuityFrequency, annuityTerm, guaranteedPeriod,
      guaranteedPart, lifePart, annuityExpense: addExpense,
    };
  }

  // ─── Полный расчёт ────────────────────────────────────────────────────────────

  fullCalculation(params, ridersCalc = null) {
    const {
      dob, gender, term, frequency,
      mode = 'sa_to_premium',
      annuityFrequency = 'annual',
      annuityTerm = 0,
      guaranteedPeriod = 0,
      saLinkedKeys = [],
      fixedRiders = [],
      hasWaiver = false,
      kMult = 1.0,
      lAdd  = 0.0,
    } = params;

    let result, sumAssured;

    if (mode === 'sa_to_premium') {
      result     = this.calculatePremium(dob, gender, term, frequency,
                                         params.sumAssured, kMult, lAdd);
      sumAssured = params.sumAssured;
    } else {
      if (ridersCalc && (saLinkedKeys.length > 0 || fixedRiders.length > 0 || hasWaiver)) {
        result = this.calculateSumAssuredWithRiders(
          dob, gender, term, frequency, params.premium,
          ridersCalc, saLinkedKeys, fixedRiders, hasWaiver, kMult, lAdd,
        );
      } else {
        result = this.calculateSumAssured(dob, gender, term, frequency,
                                          params.premium, kMult, lAdd);
      }
      sumAssured = result.sumAssured;
    }

    const reserves = this.calculateReserves(dob, gender, term, frequency,
                                            sumAssured, kMult, lAdd);

    const x       = PolicyCalculator.calculateAge(dob);
    const annuity = this.calculateAnnuity(x, term, sumAssured, annuityFrequency,
                                          annuityTerm, guaranteedPeriod, gender, kMult, lAdd);

    return { ...result, reserves, annuity, annuityPayment: annuity.annuityPayment };
  }
}
