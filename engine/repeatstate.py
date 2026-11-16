"""工程轮数同步：悬浮框更新具有版本号，旧流程负载不得覆盖新值。"""
import uuid
class RepeatState:
    def __init__(self):
        self.documents = {}
        self.current_doc = ''
        self.revision = 0
        self.epoch = uuid.uuid4().hex

    @staticmethod
    def clamp(value):
        try:
            return max(1, min(99999, int(value)))
        except (TypeError, ValueError, OverflowError):
            return 1

    def snapshot(self):
        return {**self.documents.get(self.current_doc, {'doc_id': self.current_doc, 'value': 1, 'revision': 0}), 'epoch': self.epoch}

    def set(self, value):
        value = self.clamp(value)
        previous = self.documents.get(self.current_doc)
        if previous is None or previous['value'] != value:
            self.revision += 1
            self.documents[self.current_doc] = {'doc_id': self.current_doc, 'value': value, 'revision': self.revision}
        return self.snapshot()

    def sync(self, flow):
        self.current_doc = str(flow.get('client_doc_id') or '')
        previous = self.documents.get(self.current_doc)
        try:
            revision = int(flow.get('repeat_revision', -1))
        except (TypeError, ValueError, OverflowError):
            revision = -1
        epoch_matches = 'repeat_epoch' not in flow or flow['repeat_epoch'] == self.epoch
        accepted = not previous or epoch_matches and (revision < 0 or revision >= previous['revision'])
        state = self.set(flow.get('repeat', 1)) if accepted else self.snapshot()
        flow['repeat'] = state['value']
        return state, accepted
