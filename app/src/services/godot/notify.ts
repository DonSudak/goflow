import {getNotificationManager} from '@components/Notifications';

const SHOWN = 6;

/** Toast with the number of export warnings and the first few of them. */
export const exportWarningsMessage = (warnings: string[]): string => {
  const list = warnings
    .slice(0, SHOWN)
    .map((w) => `• ${w}`)
    .join('\n');
  const more = warnings.length > SHOWN ? `\n…and ${warnings.length - SHOWN} more` : '';
  return `${warnings.length} export warning${warnings.length === 1 ? '' : 's'}:\n${list}${more}`;
};

export const notifyExportWarnings = (warnings: string[]) => {
  if (warnings.length) getNotificationManager().showError(exportWarningsMessage(warnings), true, 12000);
};
