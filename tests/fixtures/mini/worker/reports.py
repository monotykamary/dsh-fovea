# Unknown-DSL registry for the tier-3 corpus: jobm has no rule in the pack
# and no leading keyword the harvester would recognize as infra.
from jobs import weasel_export, churn_digest


def nightly():
    jobm.schedule("/ops/reports/churn", churn_digest)
    jobm.schedule("/ops/reports/weasel", weasel_export)
