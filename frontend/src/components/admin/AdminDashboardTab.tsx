import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  adminGetBoardDiversity,
  adminGetBoards,
  adminGetCountries,
  adminGetOverview,
  adminGetTimeseries,
  adminGetTopProjects,
  adminGetTopUsers,
  type BoardBreakdown,
  type BoardDiversityResponse,
  type CountryEntry,
  type OverviewResponse,
  type TimeseriesResponse,
  type TopProjectEntry,
  type TopUserEntry,
} from '../../services/metricsService';
import { countryFlag } from '../../utils/countryFlag';

const FAMILY_COLORS: Record<string, string> = {
  arduino: '#4fc3f7',
  esp32: '#a5d6a7',
  rp2040: '#ce93d8',
  'raspberry-pi': '#ef9a9a',
};

const DIVERSITY_COLORS = ['#4fc3f7', '#ffb74d', '#ba68c8'];

function familyColor(name: string | null | undefined): string {
  if (!name) return '#888';
  return FAMILY_COLORS[name] ?? '#888';
}

// ── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div style={s.kpiCard}>
      <div style={s.kpiLabel}>{label}</div>
      <div style={s.kpiValue}>{value}</div>
      {hint && <div style={s.kpiHint}>{hint}</div>}
    </div>
  );
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

const chartTooltipStyle: React.CSSProperties = {
  background: '#1e1e1e',
  border: '1px solid #3c3c3c',
  borderRadius: 4,
  color: '#ccc',
  fontSize: 12,
  padding: '6px 10px',
};

// ── Main ──────────────────────────────────────────────────────────────────────

export function AdminDashboardTab() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [compileSeries, setCompileSeries] = useState<TimeseriesResponse | null>(null);
  const [runSeries, setRunSeries] = useState<TimeseriesResponse | null>(null);
  const [boards, setBoards] = useState<BoardBreakdown[]>([]);
  const [fqbns, setFqbns] = useState<BoardBreakdown[]>([]);
  const [diversity, setDiversity] = useState<BoardDiversityResponse | null>(null);
  const [topUsers, setTopUsers] = useState<TopUserEntry[]>([]);
  const [topProjects, setTopProjects] = useState<TopProjectEntry[]>([]);
  const [countries, setCountries] = useState<CountryEntry[]>([]);
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError('');
    Promise.all([
      adminGetOverview(),
      adminGetTimeseries('compile', rangeDays, 'day'),
      adminGetTimeseries('run', rangeDays, 'day'),
      adminGetBoards(rangeDays),
      adminGetBoardDiversity(),
      adminGetTopUsers('compiles', 10),
      adminGetTopProjects('compiles', 10),
      adminGetCountries(rangeDays),
    ])
      .then(([ov, cs, rs, bd, dv, tu, tp, ct]) => {
        setOverview(ov);
        setCompileSeries(cs);
        setRunSeries(rs);
        setBoards(bd.families);
        setFqbns(bd.fqbns);
        setDiversity(dv);
        setTopUsers(tu);
        setTopProjects(tp);
        setCountries(ct.entries);
      })
      .catch(() => setError('Failed to load metrics.'))
      .finally(() => setLoading(false));
  }, [rangeDays]);

  // Merge compile + run series by bucket for the line chart
  const mergedSeries = useMemo(() => {
    if (!compileSeries && !runSeries) return [];
    const map = new Map<string, { bucket: string; compiles: number; runs: number }>();
    for (const p of compileSeries?.points ?? []) {
      map.set(p.bucket, { bucket: p.bucket, compiles: p.value, runs: 0 });
    }
    for (const p of runSeries?.points ?? []) {
      const e = map.get(p.bucket);
      if (e) e.runs = p.value;
      else map.set(p.bucket, { bucket: p.bucket, compiles: 0, runs: p.value });
    }
    return Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
  }, [compileSeries, runSeries]);

  if (loading) return <p style={s.muted}>Loading metrics…</p>;
  if (error) return <div style={s.error}>{error}</div>;
  if (!overview) return null;

  const successPct = (overview.compile_success_rate * 100).toFixed(1);

  return (
    <div style={s.wrap}>
      {/* Range selector */}
      <div style={s.rangeRow}>
        <span style={s.muted}>Range:</span>
        {[7, 30, 90, 365].map((d) => (
          <button
            key={d}
            onClick={() => setRangeDays(d)}
            style={d === rangeDays ? s.rangeBtnActive : s.rangeBtn}
          >
            {d === 365 ? '1y' : `${d}d`}
          </button>
        ))}
      </div>

      {/* KPIs */}
      <div style={s.kpiGrid}>
        <KpiCard label="Total users" value={overview.total_users} hint={`+${overview.new_users_30d} in 30d`} />
        <KpiCard label="Total projects" value={overview.total_projects} hint={`+${overview.new_projects_30d} in 30d`} />
        <KpiCard label="Compiles (all-time)" value={overview.total_compiles} hint={`${successPct}% success`} />
        <KpiCard label="Runs (all-time)" value={overview.total_runs} />
        <KpiCard label="DAU" value={overview.dau} hint="active in last 24h" />
        <KpiCard label="WAU" value={overview.wau} hint="active in last 7d" />
        <KpiCard label="MAU" value={overview.mau} hint="active in last 30d" />
        <KpiCard
          label="Public / Private"
          value={`${overview.public_projects} / ${overview.private_projects}`}
        />
      </div>

      {/* Activity over time */}
      <div style={s.chartCard}>
        <h3 style={s.chartTitle}>Activity over time</h3>
        {mergedSeries.length === 0 ? (
          <p style={s.muted}>No activity yet in this range.</p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={mergedSeries} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="bucket" stroke="#888" tick={{ fontSize: 11 }} />
              <YAxis stroke="#888" tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={chartTooltipStyle} />
              <Legend wrapperStyle={{ color: '#ccc', fontSize: 12 }} />
              <Line type="monotone" dataKey="compiles" stroke="#4fc3f7" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="runs" stroke="#a5d6a7" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div style={s.twoCol}>
        {/* Board family distribution */}
        <div style={s.chartCard}>
          <h3 style={s.chartTitle}>Compiles by board family ({rangeDays}d)</h3>
          {boards.length === 0 ? (
            <p style={s.muted}>No data.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={boards} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="board_family" stroke="#888" tick={{ fontSize: 11 }} />
                <YAxis stroke="#888" tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={chartTooltipStyle} />
                <Bar dataKey="compile_count" name="Compiles">
                  {boards.map((b, i) => (
                    <Cell key={i} fill={familyColor(b.board_family)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Board diversity (pricing signal) */}
        <div style={s.chartCard}>
          <h3 style={s.chartTitle}>How many board families per user</h3>
          <p style={s.chartSubtitle}>Pricing signal — multi-board users likely warrant paid tiers.</p>
          {diversity && diversity.total_users_with_compiles > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={diversity.buckets.map((b) => ({ name: `${b.bucket} board(s)`, value: b.user_count }))}
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  dataKey="value"
                  label={({ name, value }) => `${name}: ${value}`}
                >
                  {diversity.buckets.map((_, i) => (
                    <Cell key={i} fill={DIVERSITY_COLORS[i % DIVERSITY_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={chartTooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p style={s.muted}>No data yet.</p>
          )}
        </div>
      </div>

      {/* Top FQBNs */}
      <div style={s.chartCard}>
        <h3 style={s.chartTitle}>Top boards by FQBN ({rangeDays}d)</h3>
        {fqbns.length === 0 ? (
          <p style={s.muted}>No data.</p>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(220, fqbns.slice(0, 10).length * 32)}>
            <BarChart
              layout="vertical"
              data={fqbns.slice(0, 10)}
              margin={{ top: 10, right: 20, left: 140, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis type="number" stroke="#888" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="board_fqbn" stroke="#888" tick={{ fontSize: 11 }} width={140} />
              <Tooltip contentStyle={chartTooltipStyle} />
              <Bar dataKey="compile_count" name="Compiles">
                {fqbns.slice(0, 10).map((b, i) => (
                  <Cell key={i} fill={familyColor(b.board_family)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Top countries */}
      <div style={s.chartCard}>
        <h3 style={s.chartTitle}>Top countries ({rangeDays}d)</h3>
        <p style={s.chartSubtitle}>
          From Cloudflare's CF-IPCountry header. "Users" = current home country, "Signups" = where
          they registered, "Active" = distinct users with activity in this range.
        </p>
        {countries.length === 0 ? (
          <p style={s.muted}>No country data yet (likely running outside Cloudflare).</p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Country</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Users</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Signups</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Active ({rangeDays}d)</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Compiles</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Runs</th>
              </tr>
            </thead>
            <tbody>
              {countries.slice(0, 15).map((c, i) => (
                <tr key={c.country ?? `unknown-${i}`} style={s.tr}>
                  <td style={s.td}>
                    <span style={{ fontSize: 16, marginRight: 6 }}>{countryFlag(c.country)}</span>
                    {c.country ?? <span style={{ color: '#666' }}>Unknown</span>}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{c.user_count}</td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{c.signup_count}</td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{c.distinct_users_active}</td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{c.compile_count}</td>
                  <td style={{ ...s.td, textAlign: 'right' }}>{c.run_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Top users / projects */}
      <div style={s.twoCol}>
        <div style={s.chartCard}>
          <h3 style={s.chartTitle}>Top users by compiles</h3>
          {topUsers.length === 0 ? (
            <p style={s.muted}>No data.</p>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>#</th>
                  <th style={s.th}>User</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Compiles</th>
                </tr>
              </thead>
              <tbody>
                {topUsers.map((u, i) => (
                  <tr key={u.user_id} style={s.tr}>
                    <td style={s.td}>{i + 1}</td>
                    <td style={s.td}>{u.username}</td>
                    <td style={{ ...s.td, textAlign: 'right' }}>{u.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={s.chartCard}>
          <h3 style={s.chartTitle}>Top projects by compiles</h3>
          {topProjects.length === 0 ? (
            <p style={s.muted}>No data.</p>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>#</th>
                  <th style={s.th}>Project</th>
                  <th style={s.th}>Owner</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Compiles</th>
                </tr>
              </thead>
              <tbody>
                {topProjects.map((p, i) => (
                  <tr key={p.project_id} style={s.tr}>
                    <td style={s.td}>{i + 1}</td>
                    <td style={s.td}>{p.project_name}</td>
                    <td style={s.td}>{p.owner_username}</td>
                    <td style={{ ...s.td, textAlign: 'right' }}>{p.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 16 },
  rangeRow: { display: 'flex', alignItems: 'center', gap: 8 },
  rangeBtn: {
    background: 'transparent',
    border: '1px solid #444',
    borderRadius: 4,
    color: '#9d9d9d',
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
  rangeBtnActive: {
    background: '#0e639c',
    border: '1px solid #0e639c',
    borderRadius: 4,
    color: '#fff',
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
  muted: { color: '#777', fontSize: 13, margin: 0 },
  error: {
    background: '#5a1d1d',
    border: '1px solid #f44747',
    borderRadius: 4,
    color: '#f44747',
    padding: '8px 12px',
    fontSize: 13,
  },
  kpiGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 10,
  },
  kpiCard: {
    background: '#252526',
    border: '1px solid #3c3c3c',
    borderRadius: 6,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  kpiLabel: { color: '#9d9d9d', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  kpiValue: { color: '#fff', fontSize: 24, fontWeight: 600 },
  kpiHint: { color: '#777', fontSize: 11 },
  chartCard: {
    background: '#252526',
    border: '1px solid #3c3c3c',
    borderRadius: 6,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  chartTitle: { color: '#ccc', fontSize: 14, fontWeight: 600, margin: 0 },
  chartSubtitle: { color: '#777', fontSize: 11, margin: 0, marginBottom: 4 },
  twoCol: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
    gap: 12,
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left',
    color: '#9d9d9d',
    padding: '6px 10px',
    borderBottom: '1px solid #3c3c3c',
    fontWeight: 500,
    fontSize: 12,
  },
  tr: { borderBottom: '1px solid #2d2d2d' },
  td: { color: '#ccc', padding: '6px 10px' },
};
