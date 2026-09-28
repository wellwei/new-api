package setting

// DesignWorkbenchEnabled is the global switch for the AI design workbench
// (design doc §5.1, §2.4). Capability visibility is the intersection of this
// switch, plugin enablement, channel availability, pricing, and the user's
// usable groups; the switch alone never grants anything, it only hides the
// surface when the operator has not opted in.
var DesignWorkbenchEnabled = false
