function Home(){

return (

<div className="page home-page">


{/* 今日维修 */}

<div className="card">

<h2>
今日维修
</h2>


<div className="stats-row">


<div>

待签收

<br/>

<span>
3
</span>

</div>



<div>

维修中

<br/>

<span>
5
</span>

</div>



<div>

已完成

<br/>

<span>
12
</span>

</div>


</div>


</div>





{/* 我的任务 */}

<div className="card">


<h2>
我的任务
</h2>


<div className="task-list">


<p>

待处理维修：

<strong>
8
</strong>

</p>


<p>

暂停维修：

<strong>
2
</strong>

</p>


<p>

等待配件：

<strong>
1
</strong>

</p>


</div>


</div>






{/* 我的库存 */}

<div className="card">


<h2>
我的配件库存
</h2>



<div className="inventory-preview">


<p>

电池组件

<span>
3
</span>

</p>


<p>

边刷

<span>
5
</span>

</p>


<p>

滚刷

<span>
2
</span>

</p>



</div>



<button
className="secondary-btn"
>

查看全部库存

</button>



</div>







{/* 最近维修 */}

<div className="card">


<h2>
最近维修
</h2>



<div className="repair-record">


<p>
扫地机器人 X2
</p>


<p>
SN：R1234567A001
</p>


<p>
更换：主刷组件
</p>


<p>
昨天 16:30
</p>


</div>



</div>






</div>


)

}


export default Home