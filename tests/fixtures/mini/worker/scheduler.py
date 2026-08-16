# Unknown-DSL scheduler: jobm.schedule/route in a shape pi-fovea's pack
# does not know. Promotion should synthesize it.
from jobs import defrag, canonicalize, reindex, logdigest


def boot():
    jobm.schedule("/ops/defrag", defrag)
    jobm.schedule("/ops/canonicalize", canonicalize)
    jobm.schedule("/ops/reindex", reindex)
    jobm.schedule("/ops/logdigest", logdigest)
