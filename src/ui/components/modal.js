import { hasUnsavedChanges } from '../interaction-safety.js';
import { closeModalOverlay, openModalOverlay, updateModalOverlay } from '../overlay-store.js';

const MODAL_SIZES = new Set(['compact', 'standard', 'wide']);
let _state = null;
let _confirmationSequence = 0;

export function openModal({
  title,
  content,
  onClose,
  escDisabled = false,
  showClose = true,
  size = 'standard'
} = {}) {
  closeModal();
  const state = {
    id: '',
    dismissEnabled: !escDisabled,
    inlineSettle: null,
    onClose: typeof onClose === 'function' ? onClose : null,
    showClose: showClose !== false
  };
  _state = state;

  const finish = () => finishClose(state);
  const dismiss = async () => {
    if (_state !== state || !state.dismissEnabled || state.inlineSettle) return false;
    const dialog = document.querySelector('.modal-panel') || null;
    if (dialog && hasUnsavedChanges(dialog)) {
      const confirmed = await showModalConfirmation({
        title: 'Discard changes?',
        message: 'Discard the unsaved changes in this dialog?',
        detail: 'Your changes will not be saved.',
        confirmLabel: 'Discard changes',
        danger: true
      });
      if (!confirmed) return false;
    }
    finishClose(state);
    return true;
  };
  const setDismissEnabled = enabled => {
    state.dismissEnabled = enabled === true;
    updateModalOverlay(state.id, {
      dismissEnabled: state.dismissEnabled,
      showClose: state.showClose && state.dismissEnabled
    });
  };

  state.id = openModalOverlay({
    title: String(title || ''),
    content,
    size: MODAL_SIZES.has(size) ? size : 'standard',
    showClose: state.showClose && state.dismissEnabled,
    dismissEnabled: state.dismissEnabled,
    opener: document.activeElement,
    onDismiss: dismiss
  });
  return { close: finish, dismiss, setDismissEnabled };
}

export function updateModal({ title, content, escDisabled, showClose } = {}) {
  const state = _state;
  if (!state?.id) return false;
  if (escDisabled !== undefined) state.dismissEnabled = escDisabled !== true;
  if (showClose !== undefined) state.showClose = showClose !== false;
  return updateModalOverlay(state.id, {
    ...(title == null ? {} : { title: String(title) }),
    ...(content === undefined ? {} : { content }),
    dismissEnabled: state.dismissEnabled,
    showClose: state.showClose && state.dismissEnabled
  });
}

export function hasOpenModal() {
  return Boolean(_state?.id);
}

export function showModalConfirmation({
  title = 'Confirm action',
  message = 'Continue with this action?',
  detail = '',
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  danger = false
} = {}) {
  const state = _state;
  if (!state?.id || state.inlineSettle) return Promise.resolve(false);

  return new Promise(resolve => {
    const id = `__relai-modal-confirm-${++_confirmationSequence}`;
    let settled = false;
    const settle = (value, { render = true } = {}) => {
      if (settled) return;
      settled = true;
      state.inlineSettle = null;
      if (render && _state === state) updateModalOverlay(state.id, { confirmation: null });
      resolve(value);
    };
    state.inlineSettle = (value, options) => settle(value, options);
    updateModalOverlay(state.id, {
      confirmation: {
        id,
        title: String(title || ''),
        message: String(message || ''),
        detail: String(detail || ''),
        confirmLabel: String(confirmLabel || 'Continue'),
        cancelLabel: String(cancelLabel || 'Cancel'),
        danger: danger === true,
        onCancel: () => settle(false),
        onConfirm: () => settle(true)
      }
    });
  });
}

function finishClose(state) {
  if (_state !== state) return;
  closeModal();
}

export function closeModal() {
  const state = _state;
  if (!state) return;
  _state = null;
  closeModalOverlay(state.id);
  state.inlineSettle?.(false, { render: false });
  state.onClose?.();
}
