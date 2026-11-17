import { useState } from "react";
import { Check } from "lucide-react";
import { uid, useStore } from "../store";
import type { Group } from "../types";
import { Field, Modal } from "./ui";

const COLORS = ["#e2503a", "#e8a33d", "#3fa05a", "#3b82f6", "#8b5cf6", "#ec4899", "#0ea5e9", "#64748b"];

export function GroupDialog({ group, parentId, onClose }: { group?: Group | null; parentId?: string | null; onClose: () => void }) {
  const upsert = useStore((s) => s.upsertGroup);
  const notify = useStore((s) => s.notify);
  const groups = useStore((s) => s.ws.groups);
  const [name, setName] = useState(group?.name ?? "");
  const [color, setColor] = useState<string>(group?.color ?? COLORS[0]);
  const [parent, setParent] = useState<string>(group?.parentId ?? parentId ?? "");

  const submit = () => {
    if (!name.trim()) {
      notify("请填写分组名称", "err");
      return;
    }
    upsert({
      id: group?.id ?? uid(),
      name: name.trim(),
      color,
      parentId: parent || null,
      order: group?.order ?? Date.now(),
      expanded: group?.expanded ?? true,
    });
    notify(group ? "分组已更新" : "分组已创建", "ok");
    onClose();
  };

  return (
    <Modal
      title={group ? "编辑分组" : "新建分组"}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={submit}>
            保存
          </button>
        </>
      }
    >
      <Field label="分组名称">
        <input
          className="input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="例如：生产环境 / 本地开发"
        />
      </Field>
      <Field label="父分组">
        <select className="select" value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">（根目录）</option>
          {groups
            .filter((g) => g.id !== group?.id)
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="颜色标记">
        <div className="row" style={{ flexWrap: "wrap", gap: "0.35rem" }}>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              style={{
                width: "1.5rem",
                height: "1.5rem",
                borderRadius: "0.35rem",
                background: c,
                border: color === c ? "2px solid var(--text)" : "1px solid var(--border)",
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
              }}
              title={c}
            >
              {color === c && <Check size={12} color="#fff" />}
            </button>
          ))}
        </div>
      </Field>
    </Modal>
  );
}
