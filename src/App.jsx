import { NavLink, Route, Routes } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import StatCard from './components/StatCard'
import TransactionTable from './components/TransactionTable'
import {
  activityFeed,
  overviewStats,
  performanceData,
  serviceCards,
  transactions,
} from './data/dashboard'

const DashboardPage = () => (
  <div className="page-shell">
    <section className="hero-panel">
      <div>
        <p className="eyebrow">Operations overview</p>
        <h1>VTU performance across your network</h1>
      </div>
      <button type="button" className="primary-button">
        + New transaction
      </button>
    </section>

    <section className="stats-grid">
      {overviewStats.map((item) => (
        <StatCard key={item.label} item={item} />
      ))}
    </section>

    <section className="content-grid">
      <div className="panel panel-lg">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Daily revenue</p>
            <h3>Sales performance</h3>
          </div>
          <span className="pill success">+12.4%</span>
        </div>

        <div className="chart-wrap" aria-label="Sales performance chart">
          {performanceData.map((entry) => (
            <div key={entry.day} className="chart-column">
              <span className="chart-value">{entry.value}</span>
              <div
                className="chart-bar"
                style={{ height: `${entry.height}%` }}
                title={`${entry.day}: ${entry.value}`}
              />
              <span className="chart-label">{entry.day}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Quick actions</p>
            <h3>Service menu</h3>
          </div>
        </div>

        <div className="service-grid">
          {serviceCards.map((service) => (
            <div key={service.name} className="service-card">
              <div className="service-icon">{service.icon}</div>
              <div>
                <strong>{service.name}</strong>
                <span>{service.meta}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>

    <section className="bottom-grid">
      <div className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Latest activity</p>
            <h3>Recent transactions</h3>
          </div>
          <NavLink to="/transactions" className="text-link">
            View all
          </NavLink>
        </div>

        <TransactionTable rows={transactions.slice(0, 5)} />
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Live network</p>
            <h3>Agent activity</h3>
          </div>
        </div>

        <div className="feed-list">
          {activityFeed.map((item) => (
            <div key={item.id} className="feed-item">
              <div className={`status-dot ${item.status}`} />
              <div>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </div>
              <time>{item.time}</time>
            </div>
          ))}
        </div>
      </div>
    </section>
  </div>
)

const TransactionsPage = () => (
  <div className="page-shell">
    <section className="standard-header">
      <div>
        <p className="eyebrow">Transactions</p>
        <h1>Payment activity</h1>
      </div>
      <button type="button" className="secondary-button">
        Export report
      </button>
    </section>

    <div className="panel">
      <TransactionTable rows={transactions} />
    </div>
  </div>
)

const ServicesPage = () => (
  <div className="page-shell">
    <section className="standard-header">
      <div>
        <p className="eyebrow">Catalogue</p>
        <h1>Service offerings</h1>
      </div>
    </section>

    <div className="service-catalogue">
      {serviceCards.map((service) => (
        <div key={service.name} className="catalogue-card">
          <div className="service-icon large">{service.icon}</div>
          <h3>{service.name}</h3>
          <p>{service.meta}</p>
          <span>Availability: 99.8%</span>
        </div>
      ))}
    </div>
  </div>
)

const AgentsPage = () => (
  <div className="page-shell">
    <section className="standard-header">
      <div>
        <p className="eyebrow">Agents</p>
        <h1>Team performance</h1>
      </div>
    </section>

    <div className="agent-grid">
      {[
        { name: 'Aisha Bello', role: 'North Hub', completion: '96%', sales: '₦1.8M' },
        { name: 'Tunde Salami', role: 'Central Hub', completion: '92%', sales: '₦1.5M' },
        { name: 'Mariam Danjuma', role: 'South Hub', completion: '94%', sales: '₦1.9M' },
        { name: 'Hassan Ibrahim', role: 'East Hub', completion: '91%', sales: '₦1.4M' },
      ].map((agent) => (
        <div key={agent.name} className="agent-card">
          <div className="avatar">
            {agent.name
              .split(' ')
              .map((part) => part[0])
              .slice(0, 2)
              .join('')}
          </div>
          <h3>{agent.name}</h3>
          <p>{agent.role}</p>
          <div className="agent-meta">
            <span>Completion {agent.completion}</span>
            <strong>{agent.sales}</strong>
          </div>
        </div>
      ))}
    </div>
  </div>
)

function App() {
  return (
    <div className="app-shell">
      <Sidebar />

      <main className="main-panel">
        <Topbar />

        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/agents" element={<AgentsPage />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
