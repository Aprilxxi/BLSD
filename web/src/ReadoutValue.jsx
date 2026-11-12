export default function ReadoutValue({ label, value, unit }) {
  return <div className="readout-value">
    <span className="readout-label">{label}</span>
    <div className="readout-number"><strong>{value}</strong>{unit && <small className="readout-unit">{unit}</small>}</div>
  </div>;
}
