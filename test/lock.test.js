const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AVAX → Algorand Bridge (EVM Unit Tests)", function () {

  let TestToken, LockContract;
  let token, lock;
  let owner, user;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    // Deploy ERC20
    TestToken = await ethers.getContractFactory("TestToken");
    token = await TestToken.deploy(
      ethers.parseUnits("1000000", 18) // initial supply
    );
    await token.waitForDeployment();

    // Deploy LockContract
    LockContract = await ethers.getContractFactory("LockContract");
    lock = await LockContract.deploy(await token.getAddress());
    await lock.waitForDeployment();

    // Set relayer to owner for test
    await lock.connect(owner).setRelayer(owner.address);
  });

  it("should deploy TestToken and LockContract", async function () {
    expect(await token.name()).to.equal("TestToken");
    expect(await lock.relayer()).to.equal(owner.address);
  });

  it("user should approve LockContract", async function () {
    const amount = ethers.parseUnits("1000", 18);

    await token.connect(owner).transfer(user.address, amount);
    expect(await token.balanceOf(user.address)).to.equal(amount);

    await token.connect(user).approve(await lock.getAddress(), amount);
    expect(await token.allowance(user.address, await lock.getAddress())).to.equal(amount);
  });

  it("lock should emit event with correct data", async function () {
    const amount = ethers.parseUnits("50", 18);
    const swapId = ethers.keccak256(ethers.toUtf8Bytes("swap_test"));
    const targetAlgorandAddr = "PEBXY7IHTKE6D5YTMY6WXDDF6WNRKK5KWPXTJH4X3BDMU5EBHBYH5R7XEE";

    // Transfer tokens to user
    await token.connect(owner).transfer(user.address, amount);

    // Approve lock contract
    await token.connect(user).approve(await lock.getAddress(), amount);

    // Expect Locked event
    await expect(
      lock.connect(user).lock(amount, swapId, targetAlgorandAddr)
    ).to.emit(lock, "Locked")
      .withArgs(
        user.address,
        amount,
        swapId,
        targetAlgorandAddr
      );

    // Contract should now hold the tokens
    const bal = await token.balanceOf(await lock.getAddress());
    expect(bal).to.equal(amount);
  });

});
