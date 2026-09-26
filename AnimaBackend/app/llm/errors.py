class LLMError(Exception):
    """A provider call failed for a reason the user can act on (bad key, bad URL, ...).

    `message` is user-facing and shown verbatim in the UI.
    """

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message
