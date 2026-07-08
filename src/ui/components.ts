/** Small DOM helpers — keeps the panels declarative without a framework. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<{ className: string; text: string; html: string; title: string; type: string; placeholder: string; value: string }> = {},
  children: Array<HTMLElement | string | null> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.className) node.className = attrs.className;
  if (attrs.text !== undefined) node.textContent = attrs.text;
  if (attrs.html !== undefined) node.innerHTML = attrs.html;
  if (attrs.title) node.title = attrs.title;
  if (attrs.placeholder && "placeholder" in node) (node as HTMLInputElement).placeholder = attrs.placeholder;
  if (attrs.value !== undefined && "value" in node) (node as HTMLInputElement).value = attrs.value;
  if (attrs.type && node instanceof HTMLInputElement) node.type = attrs.type;
  for (const c of children) {
    if (c === null) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = el("button", { text: label, className });
  b.addEventListener("click", onClick);
  return b;
}

export function tag(label: string, kind: "" | "accent" | "danger" | "success" | "info" = ""): HTMLElement {
  return el("span", { className: `tag ${kind}`, text: label });
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ------------------------------------------------------------------- modal

let activeModal: HTMLElement | null = null;

export function openModal(title: string, content: HTMLElement, actions: HTMLElement[] = [], extraClass = ""): void {
  closeModal();
  const backdrop = el("div", { className: "modal-backdrop" });
  const modal = el("div", { className: `modal ${extraClass}`.trim() }, [
    el("h3", { text: title }),
    content,
    el("div", { className: "actions" }, [
      el("div", {}, actions.length > 0 ? actions : [button("Close", closeModal)]),
    ]),
  ]);
  modal.querySelector<HTMLElement>(".actions > div")!.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:14px;";
  backdrop.append(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.body.append(backdrop);
  activeModal = backdrop;
}

export function closeModal(): void {
  activeModal?.remove();
  activeModal = null;
}

export function isModalOpen(): boolean {
  return activeModal !== null;
}

// ------------------------------------------------------------------- toast

let toastStack: HTMLElement | null = null;

export function toast(text: string, ms = 4200): void {
  if (!toastStack) {
    toastStack = el("div", { className: "toast-stack" });
    document.body.append(toastStack);
  }
  const t = el("div", { className: "toast", text });
  toastStack.append(t);
  setTimeout(() => t.classList.add("fade"), ms - 600);
  setTimeout(() => t.remove(), ms);
}
