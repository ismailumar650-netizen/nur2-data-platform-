function Topbar() {
  return (
    <header className="topbar">
      <div className="search-box">
        <span aria-hidden="true">⌕</span>
        <input
          type="text"
          placeholder="Search transactions, agents, or services"
          aria-label="Search the dashboard"
        />
      </div>

      <div className="topbar-actions">
        <button type="button" className="icon-button" aria-label="Notifications">
          🔔
        </button>
        <div className="profile-pill">
          <div className="avatar small">ND</div>
          <div>
            <strong>Nur2 Data</strong>
            <span>Operations</span>
          </div>
        </div>
      </div>
    </header>
  )
}

export default Topbar
