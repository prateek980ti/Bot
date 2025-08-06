// src/utils.js
exports.sleep = ms => new Promise(r => setTimeout(r, ms));

exports.hhmmss = () => new Date().toTimeString().slice(0,8);

exports.timeIsAfter = target => {
  const [h,m,s] = target.split(':').map(Number);
  const now = new Date();
  const tgt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s);
  return now >= tgt;
};


exports.getCurrentTime = () => {
  return new Date().toLocaleTimeString('en-IN', { hour12: false });
};
