import { SignalService } from '../../../../../../protobuf';
import {
  ClosedGroupMessage,
  ClosedGroupMessageParams,
} from './ClosedGroupMessage';

export class ClosedGroupRequestInfoMessage extends ClosedGroupMessage {
  constructor(params: ClosedGroupMessageParams) {
    super({
      timestamp: params.timestamp,
      identifier: params.identifier,
      groupId: params.groupId,
    });
  }

  protected groupContext(): SignalService.GroupContext {
    // use the parent method to fill id correctly
    const groupContext = super.groupContext();
    groupContext.type = SignalService.GroupContext.Type.REQUEST_INFO;

    return groupContext;
  }
}
