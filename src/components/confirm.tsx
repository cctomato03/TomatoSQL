import { create } from "zustand";
import { Modal } from "./ui";

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  danger: boolean;
  okText: string;
  resolve?: (value: boolean) => void;
}

export const useConfirm = create<ConfirmState>(() => ({
  open: false,
  title: "",
  message: "",
  danger: false,
  okText: "确定",
}));

/** 应用内确认弹窗（替代 window.confirm，避免被 WebView 拦截且样式统一） */
export function confirmDialog(options: {
  title?: string;
  message: string;
  danger?: boolean;
  okText?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirm.setState({
      open: true,
      title: options.title ?? "请确认",
      message: options.message,
      danger: options.danger ?? true,
      okText: options.okText ?? "确定",
      resolve,
    });
  });
}

export function ConfirmHost() {
  const state = useConfirm();
  const close = (value: boolean) => {
    state.resolve?.(value);
    useConfirm.setState({ open: false, resolve: undefined });
  };
  if (!state.open) return null;
  return (
    <Modal
      title={state.title}
      size="sm"
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>
            取消
          </button>
          <button className={`btn ${state.danger ? "danger" : "primary"}`} onClick={() => close(true)} autoFocus>
            {state.okText}
          </button>
        </>
      }
    >
      <div style={{ fontSize: "0.95rem", lineHeight: 1.7, color: "var(--text-2)", whiteSpace: "pre-wrap" }}>
        {state.message}
      </div>
    </Modal>
  );
}
