import { NavLink } from 'react-router-dom'

const navItems = [
  { to: '/', label: 'Overview', icon: '◫' },
  { to: '/transactions', label: 'Transactions', icon: '⇄' },
  { to: '/services', label: 'Services', icon: '▣' },
  { to: '/agents', label: 'Agents', icon: '◉' },
]

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-mark">N</div>
        <div>
          <span className="brand-name">Nur2 Data</span>
          <small>VTU Platform</small>
        </div>
      </div>

      <nav className="nav-list" aria-label="Sidebar navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            end={item.to === '/'}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-card">
        <p className="eyebrow">System status</p>
        <strong>Healthy</strong>
        <span>99.98% uptime</span>
      </div>
    </aside>
  )
}

export default Sidebar
