<template>
  <div v-if="rows.length > 0" class="indexation-block">
    <div class="ix-toggle" @click="open = !open" :class="{ expanded: open }">
      <span class="icon">📈</span>
      <span class="ix-title">{{ t('indexation.title') }}</span>
      <InfoTooltip v-bind="tip('indexationResult')" />
      <span class="ix-arrow">{{ open ? '▲' : '▼' }}</span>
    </div>

    <div v-if="open" class="ix-wrap">
      <table class="data-table ix-table">
        <thead>
          <tr>
            <th class="col-num">{{ t('indexation.colNum') }}</th>
            <th>{{ t('indexation.colPeriod') }}</th>
            <th class="num">{{ t('indexation.colPremium') }}</th>
            <th class="num">{{ t('indexation.colSA') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, idx) in rows" :key="r.year">
            <td class="col-num">{{ idx + 1 }}</td>
            <td class="col-date">{{ formatPeriod(r) }}</td>
            <td class="num col-prem">{{ fmt(r.premium) }}</td>
            <td class="num col-sa">{{ fmt(r.sumAssured) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="row-total">
            <td class="col-num col-total-label">{{ t('indexation.totalLabel') }}</td>
            <td class="col-date col-total-period">{{ totalPeriod }}</td>
            <td class="num col-prem col-total-value">{{ fmt(totalPremium) }}</td>
            <td class="num col-sa col-total-value">{{ fmt(maxSA) }}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import InfoTooltip from './InfoTooltip.vue';
import { useI18n } from '../i18n/index.js';

const { t, tip } = useI18n();

const props = defineProps({
  result: { type: Object, default: null },
});

const open = ref(true);

const rows = computed(() => props.result?.indexationSchedule ?? []);

// Сколько РЕАЛЬНЫХ платежей клиент делает за каждый год индексации.
// Значение `premium` в строке — это сумма ЗА ОДИН ПЕРИОД (как в эталоне:
// для monthly — месячный взнос, для quarterly — квартальный и т.д.).
// Чтобы ИТОГО = полная сумма всех уплаченных денег за срок, нужно
// умножить на количество платежей в году.
const PAYMENTS_PER_YEAR = {
  annual: 1, semiannual: 2, quarterly: 4, monthly: 12, single: 1,
};

// Итого:
//   • по премии — сумма всех значений × платежей в году (полная сумма всех уплат)
//   • по СС    — максимальное значение (= СС последнего года, т.к. СС монотонно растёт)
const totalPremium = computed(() => {
  const sum  = rows.value.reduce((s, r) => s + (r.premium || 0), 0);
  const freq = props.result?.frequency || 'annual';
  const mult = PAYMENTS_PER_YEAR[freq] ?? 1;
  return sum * mult;
});
const maxSA = computed(() => rows.value.reduce((m, r) => Math.max(m, r.sumAssured || 0), 0));

// Период итого = диапазон от даты первого периода до конца последнего
const totalPeriod = computed(() => {
  if (rows.value.length === 0) return '';
  const first = rows.value[0]?.date;
  const last  = rows.value[rows.value.length - 1]?.dateEnd;
  if (!first || !last) return '';
  const f = (iso) => { const [y,m,d] = iso.split('-'); return `${d}.${m}.${y}`; };
  return `${f(first)} – ${f(last)}`;
});

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  // NBSP перед ₸ — символ валюты не переносится на отдельную строку на мобильном
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
    .format(Math.round(v)) + ' ₸';
}
function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}
function formatPeriod(r) {
  if (!r.dateEnd) return formatDate(r.date);
  return `${formatDate(r.date)} – ${formatDate(r.dateEnd)}`;
}
</script>

<style scoped>
.indexation-block {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(95,189,245,0.22);
  border-radius: 16px;
  padding: 14px 16px;
  margin-top: 14px;
}
.ix-toggle {
  display: flex; align-items: center; gap: 10px;
  cursor: pointer;
  user-select: none;
  font-weight: 700;
  font-size: 18px;
  color: #FFFFFF;
}
.ix-toggle .icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px;
  border-radius: 10px;
  background: rgba(161,201,90,0.18);
  font-size: 20px;
}
/* Заголовок не растягивается — (i) встаёт сразу после текста, стрелка прижата вправо */
.ix-title { flex: 0 1 auto; min-width: 0; }
.ix-arrow { font-size: 12px; opacity: 0.7; margin-left: auto; }
.ix-toggle.expanded { padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.10); margin-bottom: 10px; }

.ix-wrap {
  /* На десктопе оставляем скролл как резерв, на мобильном — табл.layout=fixed
     и word-break=break-word делают так, что таблица всегда помещается. */
  overflow-x: hidden;
  /* Скруглённые углы таблицы (обрезаются вместе с шапкой и строкой «Итого») */
  border-radius: 16px;
}
.ix-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 16px;
}
.ix-table th, .ix-table td {
  padding: 10px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  text-align: center;            /* всё по центру */
  vertical-align: middle;
  white-space: nowrap;
}
.ix-table th {
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 13px;
  color: #B3D9FF;
  background: linear-gradient(135deg, #2D5171, #4A7295);
  position: sticky; top: 0; z-index: 1;
  /* Длинные заголовки переносятся, чтобы колонки с крупными значениями помещались */
  white-space: normal;
  line-height: 1.3;
}
.ix-table tbody tr:nth-child(odd) td { background: rgba(161,201,90,0.07); }
.ix-table tbody tr:nth-child(even) td { background: rgba(95,189,245,0.05); }
.ix-table tbody tr:hover td { background: rgba(95,189,245,0.16); }

.num { font-family: 'SF Mono', 'Menlo', monospace; }
.col-num { color: #5FBDF5; font-weight: 700; width: 60px; }
.col-date { color: #B3D9FF; }
.col-prem { color: #FFFFFF; font-weight: 600; font-size: 17px; }
.col-sa   { color: #A1C95A; font-weight: 700; font-size: 17px; }

/* ── Итого — в стилистике верхних бейджей (СС / итого премия) ── */
.row-total td {
  background: linear-gradient(to right, #A1C95A, #5C8E2F) !important;
  border-top: none;
  border-bottom: none;
  font-size: 18px;
  padding: 14px;
  color: #FFFFFF;
}
.col-total-label {
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #FFFFFF;
}
.row-total .col-date { color: rgba(255,255,255,0.92); }
.row-total .col-sa,
.row-total .col-prem { color: #FFFFFF; }
.col-total-value {
  font-weight: 800;
  font-family: 'SF Mono', 'Menlo', monospace;
}

@media (max-width: 720px) {
  /* На мобильных таблица должна помещаться без горизонтального скролла:
     − скрываем колонку «№» (она не несёт смысла, есть период)
     − форматирование дат «10.06.2026 – 10.06.2027» переносится на 2 строки
     − суммы в одну строку, но компактным шрифтом
     − убираем внутренние padding'и до минимума */
  .ix-wrap { overflow-x: hidden; }
  /* Заголовок блока на мобильном компактнее (на десктопе — 18px) */
  .ix-toggle { font-size: 14px; gap: 8px; }
  .ix-toggle .icon { width: 30px; height: 30px; font-size: 16px; border-radius: 8px; }
  .ix-table { font-size: 12px; table-layout: fixed; width: 100%; }
  .ix-table th, .ix-table td {
    padding: 6px 4px;
    white-space: normal;
    word-break: keep-all;
    line-height: 1.25;
  }
  .ix-table th  { font-size: 9.5px; letter-spacing: 0.02em; }
  /* Значения на мобильном компактнее (десктопные 17px не помещаются в колонки) */
  .col-prem, .col-sa { font-size: 12.5px; }
  /* Колонка № — лишняя на мобильном */
  .ix-table th:first-child,
  .ix-table td:first-child { display: none; }
  /* Колонкам значений — больше места (СС доходит до 8 знаков: «11 570 101 ₸»),
     даты и так переносятся на две строки */
  .ix-table th:nth-child(2),
  .ix-table td:nth-child(2) { width: 28%; }
  .ix-table th:nth-child(3),
  .ix-table td:nth-child(3),
  .ix-table th:nth-child(4),
  .ix-table td:nth-child(4) { width: 36%; }

  .row-total td { font-size: 12px !important; padding: 8px 4px !important; }
  /* Раз колонка № скрыта — перед диапазоном дат добавляем метку «ИТОГО» */
  .row-total .col-total-period::before {
    content: 'ИТОГО · ';
    font-weight: 800;
    color: #FFFFFF;
    letter-spacing: 0.04em;
  }
}
</style>
