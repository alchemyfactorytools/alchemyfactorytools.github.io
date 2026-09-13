// Heating devices (game 1.0).
//
// A heated machine (slotsRequired > 0) sits on a generator chosen by config: Stone
// Furnace, Blast Furnace, or Steam Heating Pad. The generator hosts `slots` slot
// units and is packed: ceil(Σ machineCount × slotsRequired / slots). Since 1.0 no
// generator draws base heat, so the device only changes how many you build.

'use strict';

const { heatingDeviceFor } = require('./config');

function heatingDevice(db, cfg) {
  const name = heatingDeviceFor(cfg);
  const m = db.machines[name];
  if (!m || !m.isGenerator) throw new Error(`heatingDevice "${name}" is not a heat generator in the dataset`);
  return { name, slots: m.slots || 9 };
}

const isHeated = (machine) => !!machine && machine.slotsRequired > 0;

// Generators needed to host `machineCount` of `machine` on `device`.
function generatorsFor(machine, machineCount, device) {
  if (!isHeated(machine) || !machineCount) return 0;
  return Math.ceil((machineCount * machine.slotsRequired) / device.slots - 1e-9);
}

module.exports = { heatingDevice, isHeated, generatorsFor };
