const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

function publish(event) {
  bus.emit('event', event);
  if (event && event.type) bus.emit(event.type, event);
}

function subscribe(handler) {
  bus.on('event', handler);
  return () => bus.off('event', handler);
}

module.exports = {
  publish,
  subscribe,
  bus
};
