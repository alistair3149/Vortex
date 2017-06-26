import { createAction } from 'redux-act';

export const setSource = createAction('SET_PLUGIN_CONNECTION_SOURCE',
  (id: string, pos: { x: number, y: number }) => ({ id, pos }));

export const setTarget = createAction('SET_PLUGIN_CONNECTION_TARGET',
  (id: string, pos: { x: number, y: number }) => ({ id, pos }));

export const setCreateRule = createAction('SET_PLUGIN_CREATE_RULE',
  (gameId: string, pluginId: string, reference: string, defaultType: string) =>
    ({ gameId, pluginId, reference, type: defaultType }));

export const closeDialog = createAction('CLOSE_PLUGIN_RULE_DIALOG');
