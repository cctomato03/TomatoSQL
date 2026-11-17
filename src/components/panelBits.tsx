export { Spinner, Empty } from "./ui";

export function DataEmpty() {
  return (
    <div className="empty">
      <div className="empty-title">没有可显示的数据</div>
      <div className="empty-text">请检查表是否存在，或调整筛选条件后重试。</div>
    </div>
  );
}
