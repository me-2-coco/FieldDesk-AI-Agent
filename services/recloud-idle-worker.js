function chooseIdleRecloudWorker(workers, affinityKey) {
  const idle = workers.filter(worker => !worker.busy && !worker.retired);
  return (affinityKey && idle.find(worker => worker.affinityKey === affinityKey)) || idle[0];
}
module.exports = { chooseIdleRecloudWorker };
