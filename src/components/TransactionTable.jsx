function TransactionTable({ rows }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Service</th>
            <th>Value</th>
            <th>Status</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.customer}-${row.time}`}>
              <td>{row.customer}</td>
              <td>{row.service}</td>
              <td>{row.value}</td>
              <td>
                <span className={`status-badge ${row.status.toLowerCase()}`}>{row.status}</span>
              </td>
              <td>{row.time}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default TransactionTable
