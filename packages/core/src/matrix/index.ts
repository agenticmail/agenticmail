export {
  MatrixApiError,
  MATRIX_MESSAGE_LIMIT,
  getMatrixWhoami,
  sendMatrixMessage,
  getMatrixSync,
  parseMatrixSyncMessages,
} from './client.js';
export type {
  MatrixApiOptions,
  MatrixWhoami,
  SendMatrixMessageResult,
  MatrixSyncOptions,
  ParsedMatrixMessage,
} from './client.js';

export {
  MatrixManager,
  buildMatrixConfig,
  redactMatrixConfig,
  isMatrixRoomAllowed,
} from './manager.js';
export type {
  MatrixConfig,
  MatrixMessage,
} from './manager.js';
