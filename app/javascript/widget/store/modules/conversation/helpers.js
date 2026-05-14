import { MESSAGE_TYPE } from 'widget/helpers/constants';
import { isASubmittedFormMessage } from 'shared/helpers/MessageTypeHelper';

import getUuid from '../../../helpers/uuid';
export const createTemporaryMessage = ({ attachments, content, replyTo }) => {
  const timestamp = new Date().getTime() / 1000;
  return {
    id: getUuid(),
    content,
    attachments,
    status: 'in_progress',
    replyTo,
    created_at: timestamp,
    message_type: MESSAGE_TYPE.INCOMING,
  };
};

const getSenderName = message => (message.sender ? message.sender.name : '');

const isHandoffNotification = message =>
  message?.additional_attributes?.handoff_notification === true;

const shouldShowAvatar = (message, nextMessage) => {
  const currentSender = getSenderName(message);
  const nextSender = getSenderName(nextMessage);

  return (
    currentSender !== nextSender ||
    message.message_type !== nextMessage.message_type ||
    isASubmittedFormMessage(nextMessage)
  );
};

export const groupConversationBySender = conversationsForADate =>
  conversationsForADate.map((message, index) => {
    let showAvatar;
    const isLastMessage = index === conversationsForADate.length - 1;
    if (isHandoffNotification(message) || isASubmittedFormMessage(message)) {
      showAvatar = false;
    } else if (isLastMessage) {
      showAvatar = true;
    } else {
      const nextNonHandoff = conversationsForADate
        .slice(index + 1)
        .find(m => !isHandoffNotification(m));
      if (!nextNonHandoff) {
        showAvatar = true;
      } else {
        showAvatar = shouldShowAvatar(message, nextNonHandoff);
      }
    }
    return { showAvatar, ...message };
  });

export const findUndeliveredMessage = (messageInbox, { content }) =>
  Object.values(messageInbox).filter(
    message => message.content === content && message.status === 'in_progress'
  );

export const getNonDeletedMessages = ({ messages }) => {
  return messages.filter(
    item => !(item.content_attributes && item.content_attributes.deleted)
  );
};
