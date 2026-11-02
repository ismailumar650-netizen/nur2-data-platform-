function StatCard({ item }) {
  return (
    <article className="stat-card">
      <div className="stat-header">
        <span className="stat-label">{item.label}</span>
        <span className={`stat-trend ${item.trendType}`}>{item.trend}</span>
      </div>
      <div className="stat-value-row">
        <h2>{item.value}</h2>
        <span className="stat-icon" aria-hidden="true">{item.icon}</span>
      </div>
      <p>{item.caption}</p>
    </article>
  )
}

export default StatCard
