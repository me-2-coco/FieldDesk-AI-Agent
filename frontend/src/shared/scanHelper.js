export function identifyScanCode(code) {

  const value = code.trim().toUpperCase();


  // SN判断
  if(
    value.startsWith("W") ||
    value.startsWith("R")
  ){

    return {
      type:"SN",
      value:value
    };

  }


  // 物流单号判断

  if(
    value.startsWith("SF") ||
    value.startsWith("YT") ||
    value.startsWith("JD") ||
    value.startsWith("ST")
  ){

    return {
      type:"LOGISTICS",
      value:value
    };

  }


  // 配件编码

  if(
    /^[0-9]+$/.test(value)
  ){

    return {
      type:"PART",
      value:value
    };

  }


  return {

    type:"UNKNOWN",

    value:value

  };

}